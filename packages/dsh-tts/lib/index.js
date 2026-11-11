/**
 * dsh-tts — server half.
 *
 * A Cordis plugin that gives the TTS client half everything it cannot do in the
 * browser:
 *   - RPC channel `/voice-tts` (registered through the `connection` service, so
 *     the platform's browser fence guards it: loopback Host, same-origin and a
 *     live browser session cookie) with endpoints:
 *       `status`, `prepare`, `prepareStatus`, `synthesize`, `voices`, `cancel`.
 *   - Engine `edge`: neural voices from Microsoft Edge read-aloud (online) via a
 *     persistent Python worker (`runtime/tts_worker.py`, JSON Lines over
 *     stdin/stdout, `edge-tts` inside `<home>/tts/venv`).
 *   - Engine `sapi`: Windows `System.Speech` through `runtime/sapi.ps1`, fully
 *     offline. The spoken text always travels through a UTF-8 file, never a
 *     command-line argument, so there is no quoting/injection path.
 *   - Engine `browser` lives entirely in the client (`speechSynthesis`); the
 *     server rejects requests that ask for it.
 *   - An LRU cache under `<home>/tts/cache` keyed by
 *     `sha256(engine|voice|rate|pitch|text)` with a 50 MB / 300 file budget,
 *     pruned at boot and after writes.
 *
 * Runtime home: `DSH_VOICE_HOME || path.join(os.homedir(), '.dsh', 'dsh-voice')`,
 * engine state under `<home>/tts/{venv,cache,logs,config.json}`.
 *
 * Security model: the client never supplies a filesystem path, an executable,
 * or an arbitrary command. Only closed voice lists, bounded text and bounded
 * numeric options cross the RPC boundary; every failure maps to one of the two
 * shared RPC error codes (`bad-request`, `internal`).
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name. */
export const name = 'tts';
/** Services required before this plugin can mount (`webServer` backs the RPC route). */
export const inject = ['webServer', 'connection'];

/** RPC channel the client half calls; must match `/^\/[A-Za-z0-9._~-]+$/`. */
const CHANNEL = '/voice-tts';
/** Plugin version reported by `status` and the browser debug hook. */
const PLUGIN_VERSION = '1.0.0';
/** Package root (works from both `src/` and the mirrored `lib/`). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Maximum characters the server accepts in one `synthesize` request. */
const TEXT_MAX_CHARS = 4000;
/** Minimum bytes that count as a real audio payload. */
const AUDIO_MIN_BYTES = 1024;
/** Rate bounds (1 = natural speed). */
const RATE_MIN = 0.5;
const RATE_MAX = 2;
/** Pitch bounds in Hz (edge) — SAPI has no pitch knob. */
const PITCH_MIN = -20;
const PITCH_MAX = 20;

/** LRU cache budget. */
const CACHE_MAX_FILES = 300;
const CACHE_MAX_BYTES = 50 * 1024 * 1024;
/** Stale temp files older than this are removed during pruning. */
const CACHE_TEMP_TTL_MS = 60 * 60 * 1000;

/** Deadlines (ms). */
const EDGE_SYNTH_TIMEOUT_MS = 45_000;
const EDGE_VOICES_TIMEOUT_MS = 25_000;
const EDGE_PING_TIMEOUT_MS = 20_000;
const EDGE_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const SAPI_TIMEOUT_MS = 30_000;
const VENV_TIMEOUT_MS = 120_000;
const PIP_TIMEOUT_MS = 420_000;
const VERIFY_TIMEOUT_MS = 30_000;

/** Cache/output MIME types. */
const MIME_EDGE = 'audio/mpeg';
const MIME_SAPI = 'audio/wav';

/** Languages this plugin supports. */
const LANGUAGES = ['pt-BR', 'en-US'];

/** Closed edge voice list (validated before use). */
const EDGE_VOICES = {
  'pt-BR': ['pt-BR-FranciscaNeural', 'pt-BR-AntonioNeural', 'pt-BR-ThalitaMultilingualNeural'],
  'en-US': ['en-US-AriaNeural', 'en-US-GuyNeural', 'en-US-JennyNeural', 'en-US-BrianMultilingualNeural'],
};

/**
 * Preferred SAPI voices per language, in fallback order. A voice is only used
 * when the machine actually has it installed; otherwise the first installed
 * voice of the language (or the system default) is used.
 */
const SAPI_VOICES = {
  'pt-BR': ['Microsoft Maria Desktop', 'Microsoft Maria', 'Microsoft Daniel'],
  'en-US': ['Microsoft Zira Desktop', 'Microsoft David Desktop', 'Microsoft Mark'],
};

/** Engines accepted from the client (`browser` is client-side only). */
const SERVER_ENGINES = ['auto', 'edge', 'sapi'];

/** Default persisted configuration. */
const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  engine: 'auto',
  rate: 1,
  pitch: 0,
  voices: Object.freeze({ 'pt-BR': null, 'en-US': null }),
});

/** Control characters stripped from synthesised text (keeps `\n` and `\t`). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// ── errors ───────────────────────────────────────────────────────────────────

/** Business error converted to the RPC error branch at the boundary. */
class TtsError extends Error {
  /**
   * @param {'bad-request' | 'internal'} code RPC error code.
   * @param {string} message Human-readable message (safe to show in the UI).
   * @param {Record<string, unknown>} [details] Optional structured details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} message @param {Record<string, unknown>} [details] */
const badRequest = (message, details) => new TtsError('bad-request', message, details);
/** @param {string} message @param {Record<string, unknown>} [details] */
const internal = (message, details) => new TtsError('internal', message, details);

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return String(error && typeof error === 'object' && 'message' in error ? error.message : error);
}

// ── small helpers ───────────────────────────────────────────────────────────

/** Data home shared with the STT plugin. */
export function voiceHome() {
  const configured = process.env.DSH_VOICE_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim());
  return path.join(os.homedir(), '.dsh', 'dsh-voice');
}

/** @param {string} text @returns {string} sha256 hex digest */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Validate and defensively sanitize one synthesis text.
 * @param {unknown} raw Value received from the client.
 * @returns {string} Cleaned text.
 * @throws {TtsError} `bad-request` when the value is missing/empty/oversized.
 */
export function sanitizeText(raw) {
  if (typeof raw !== 'string') throw badRequest('text must be a string');
  const text = raw.replace(CONTROL_CHARS, ' ').replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) throw badRequest('text must not be empty');
  if (text.length > TEXT_MAX_CHARS) {
    throw badRequest(`text exceeds the ${TEXT_MAX_CHARS} character limit`, {
      length: text.length,
      max: TEXT_MAX_CHARS,
    });
  }
  return text;
}

/**
 * Normalize a language tag to the closed supported set.
 * @param {unknown} raw
 * @returns {'pt-BR' | 'en-US'}
 */
export function normalizeLang(raw) {
  if (raw === undefined || raw === null) return 'pt-BR';
  if (typeof raw !== 'string') throw badRequest('lang must be a string');
  const value = raw.trim();
  if (value === 'pt' || /^pt([-_]br)?$/i.test(value)) return 'pt-BR';
  if (value === 'en' || /^en([-_]us)?$/i.test(value)) return 'en-US';
  throw badRequest(`unsupported language: ${value}`, { supported: LANGUAGES });
}

/**
 * Normalize an engine preference.
 * @param {unknown} raw
 * @returns {'auto' | 'edge' | 'sapi'}
 */
export function normalizeEngine(raw) {
  if (raw === undefined || raw === null) return 'auto';
  if (typeof raw !== 'string') throw badRequest('engine must be a string');
  const value = raw.trim().toLowerCase();
  if (value === 'browser') throw badRequest('the browser engine is client-side and cannot be synthesized on the host');
  if (!SERVER_ENGINES.includes(value)) {
    throw badRequest(`unsupported engine: ${value}`, { supported: SERVER_ENGINES });
  }
  return /** @type {'auto' | 'edge' | 'sapi'} */ (value);
}

/**
 * Read a bounded numeric option.
 * @param {unknown} value Raw client value.
 * @param {number} fallback Value used when absent.
 * @param {number} min Inclusive minimum.
 * @param {number} max Inclusive maximum.
 * @param {string} field Field name used in the error message.
 * @returns {number}
 */
export function readNumber(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest(`${field} must be a number`);
  if (value < min || value > max) throw badRequest(`${field} must be between ${min} and ${max}`, { min, max });
  return value;
}

/**
 * Map the client rate (0.5..2) to the edge-tts `+N%` spelling.
 * @param {number} rate
 * @returns {string}
 */
export function edgeRateString(rate) {
  const delta = Math.round((rate - 1) * 100);
  return `${delta >= 0 ? '+' : ''}${delta}%`;
}

/**
 * Map the client pitch (Hz, -20..20) to the edge-tts `+NHz` spelling.
 * @param {number} pitch
 * @returns {string}
 */
export function edgePitchString(pitch) {
  const hz = Math.round(pitch);
  return `${hz >= 0 ? '+' : ''}${hz}Hz`;
}

/**
 * Map the client rate (0.5..2) to the SAPI `-10..10` rate knob.
 * @param {number} rate
 * @returns {number}
 */
export function sapiRateValue(rate) {
  return Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)));
}

/**
 * Build the stable cache key for one synthesis request.
 * @param {{engine: string, voice: string, rate: number, pitch: number, text: string}} parts
 * @returns {string}
 */
export function cacheKey(parts) {
  return sha256([parts.engine, parts.voice, String(parts.rate), String(parts.pitch), parts.text].join('\u0000'));
}

/** @param {string} id @returns {string} Friendly voice label. */
function edgeVoiceLabel(id) {
  const bare = id.replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/Neural$/, '');
  if (/Multilingual$/i.test(bare)) return `${bare.replace(/Multilingual$/i, '')} (multilingual)`;
  return `${bare} (neural)`;
}

/** @param {string} name @returns {string} Friendly SAPI label. */
function sapiVoiceLabel(name) {
  return name.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, '');
}

/**
 * Case-insensitive language comparison (`pt-BR` vs `pt_br`).
 * @param {string} left @param {string} right
 */
function sameLang(left, right) {
  return String(left).replace(/_/g, '-').toLowerCase() === String(right).replace(/_/g, '-').toLowerCase();
}

/** @param {string} dir @param {string} text Append one diagnostic block to a log file. */
async function appendLog(dir, text) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, 'runtime.log'), text, 'utf8');
  } catch {
    /* logging must never break synthesis */
  }
}

/**
 * Run one short-lived process and capture its output.
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string}>}
 */
function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...options.env },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: typeof error?.code === 'number' ? error.code : error ? -1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

/**
 * Parse a `Python X.Y.Z` version line (stderr on old interpreters).
 * @param {string} stdout @param {string} stderr
 * @returns {{major: number, minor: number, patch: number, text: string} | null}
 */
function parsePythonVersion(stdout, stderr) {
  const match = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(`${stdout}\n${stderr}`);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
    text: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`,
  };
}

// ── Edge neural worker (persistent Python, JSON Lines) ──────────────────────

/**
 * Owns the `runtime/tts_worker.py` child process. One worker is reused across
 * requests; it is killed after `EDGE_IDLE_SHUTDOWN_MS` of inactivity, on
 * `cancel`, on `synthesize` timeout, and on plugin dispose.
 */
class EdgeWorker {
  /** @param {TtsService} service */
  constructor(service) {
    this.service = service;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.idleTimer = null;
    this.logStream = null;
  }

  /** Append one line to the worker log (best effort). */
  logLine(line) {
    try {
      if (!this.logStream) {
        const logPath = path.join(this.service.logsDir, 'worker.log');
        this.logStream = createWriteStream(logPath, { flags: 'a' });
        this.logStream.on('error', () => {
          this.logStream = null;
        });
      }
      this.logStream.write(`${new Date().toISOString()} ${line}\n`);
    } catch {
      /* diagnostics only */
    }
  }

  /** @returns {boolean} Whether a live worker process exists. */
  get alive() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** Ensure one live worker exists. */
  async ensure() {
    if (this.alive) return;
    if (this.starting) return this.starting;
    this.starting = this.spawnWorker().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Spawn the worker process and wire its JSON-Lines protocol. */
  async spawnWorker() {
    const python = this.service.venvPythonPath();
    if (!existsSync(python)) throw internal('edge runtime is not prepared (run prepare first)');
    if (!existsSync(this.service.workerScript)) throw internal('edge worker script is missing');
    await new Promise((resolve, reject) => {
      const child = spawn(python, ['-u', this.service.workerScript], {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onStdout(chunk));
      child.stderr.on('data', (chunk) => this.logLine(`stderr: ${String(chunk).trimEnd()}`));
      child.once('spawn', () => {
        this.child = child;
        resolve();
      });
      child.once('error', (error) => {
        this.child = null;
        reject(internal(`could not start the edge worker: ${messageOf(error)}`));
      });
      child.once('exit', (code, signal) => {
        this.logLine(`worker exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
        // A replacement worker may already be serving new requests: only the
        // still-current child owns the pending map.
        if (this.child !== child) return;
        this.child = null;
        this.rejectAll(internal('edge worker stopped unexpectedly', { code: code ?? null }));
      });
    });
    this.armIdleTimer();
  }

  /** @param {string} chunk */
  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== '') this.onLine(line);
    }
  }

  /** @param {string} line */
  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logLine(`non-protocol stdout: ${line.slice(0, 500)}`);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      this.logLine(`unexpected response id ${String(message.id)}`);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === true) {
      entry.resolve(message.result ?? {});
      return;
    }
    const error = message.error ?? {};
    entry.reject(internal(`edge synthesis failed: ${String(error.message ?? 'unknown error')}`, {
      code: error.code ?? 'edge-error',
    }));
  }

  /** Reject every pending request (worker died / was killed). */
  rejectAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  /**
   * Send one JSON-Lines request and await its response.
   * @param {string} command
   * @param {Record<string, unknown>} payload
   * @param {number} timeoutMs
   * @returns {Promise<Record<string, unknown>>}
   */
  async request(command, payload, timeoutMs) {
    await this.ensure();
    this.clearIdleTimer();
    const id = this.nextId++;
    const request = JSON.stringify({ id, cmd: command, ...payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(internal(`edge worker timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${request}\n`, 'utf8', (error) => {
          if (!error) return;
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(internal(`could not write to the edge worker: ${messageOf(error)}`));
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(internal(`could not reach the edge worker: ${messageOf(error)}`));
      }
    }).finally(() => {
      this.armIdleTimer();
    });
  }

  /** @param {{text: string, voice: string, rate: string, pitch: string, out: string}} payload */
  async synthesize(payload) {
    return this.request('synthesize', payload, EDGE_SYNTH_TIMEOUT_MS);
  }

  clearIdleTimer() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  armIdleTimer() {
    this.clearIdleTimer();
    if (!this.alive) return;
    this.idleTimer = setTimeout(() => {
      this.logLine('idle shutdown');
      this.kill();
    }, EDGE_IDLE_SHUTDOWN_MS);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  /** Kill the worker immediately (pending requests reject). */
  kill() {
    this.clearIdleTimer();
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.rejectAll(internal('edge worker was stopped'));
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /** Graceful shutdown used by plugin dispose. */
  dispose() {
    this.clearIdleTimer();
    const child = this.child;
    if (!child) {
      this.closeLog();
      return;
    }
    try {
      child.stdin.end(`${JSON.stringify({ id: 0, cmd: 'shutdown' })}\n`);
    } catch {
      /* already closed */
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
    this.child = null;
    this.rejectAll(internal('edge worker was stopped'));
    setTimeout(() => this.closeLog(), 1200).unref?.();
  }

  closeLog() {
    try {
      this.logStream?.end();
    } catch {
      /* ignore */
    }
    this.logStream = null;
  }
}

// ── service ─────────────────────────────────────────────────────────────────

/**
 * Everything the RPC surface needs: paths, config, cache, engines and the
 * long-running `prepare` job.
 */
export class TtsService {
  /** @param {import('cordis').Context} ctx Owning Cordis context. */
  constructor(ctx) {
    this.ctx = ctx;
    this.home = voiceHome();
    this.ttsRoot = path.join(this.home, 'tts');
    this.venvDir = path.join(this.ttsRoot, 'venv');
    this.cacheDir = path.join(this.ttsRoot, 'cache');
    this.logsDir = path.join(this.ttsRoot, 'logs');
    this.configPath = path.join(this.ttsRoot, 'config.json');
    this.workerScript = path.join(PACKAGE_ROOT, 'runtime', 'tts_worker.py');
    this.sapiScript = path.join(PACKAGE_ROOT, 'runtime', 'sapi.ps1');
    this.requirementsPath = path.join(PACKAGE_ROOT, 'runtime', 'requirements.txt');

    this.config = { ...DEFAULT_CONFIG, voices: { ...DEFAULT_CONFIG.voices } };
    this.worker = new EdgeWorker(this);

    /** @type {{running: boolean, phase: string, progress: number, message: string, error: string | null, startedAt: number, finishedAt: number, cancelRequested: boolean, installedVersion: string | null}} */
    this.prepareState = {
      running: false,
      phase: 'idle',
      progress: 0,
      message: 'idle',
      error: null,
      startedAt: 0,
      finishedAt: 0,
      cancelRequested: false,
      installedVersion: null,
    };
    this.prepareTask = null;
    this.pipChild = null;
    this.pythonCache = { at: 0, value: null };
    this.sapiCache = { at: 0, value: [] };
    this.pruning = false;
    this.pruneAgain = false;
    this.pruneTimer = null;
    this.persistTimer = null;
    this.persistedAt = 0;
    this.disposed = false;
    this.bootPromise = this.boot();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Create runtime directories, load config and prune the cache (non-fatal). */
  async boot() {
    try {
      await fsp.mkdir(this.cacheDir, { recursive: true });
      await fsp.mkdir(this.logsDir, { recursive: true });
    } catch (error) {
      console.warn('[voice-tts] could not create runtime directories:', messageOf(error));
    }
    await this.loadConfig();
    await this.pruneCache('boot');
  }

  /** Stop workers, cancel prepare and flush timers. Idempotent. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.prepareState.cancelRequested = true;
    this.worker.dispose();
    if (this.pipChild) {
      try {
        this.pipChild.kill();
      } catch {
        /* already gone */
      }
      this.pipChild = null;
    }
    if (this.pruneTimer !== null) clearTimeout(this.pruneTimer);
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.pruneTimer = null;
    this.persistTimer = null;
  }

  // ── paths ─────────────────────────────────────────────────────────────────

  /** @returns {string} Path of the venv interpreter. */
  venvPythonPath() {
    return path.join(this.venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  }

  /** @returns {string} PowerShell executable used for SAPI. */
  powershellPath() {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return existsSync(full) ? full : 'powershell.exe';
  }

  // ── config ────────────────────────────────────────────────────────────────

  /** Load `<tts>/config.json` tolerantly, then write normalized defaults back. */
  async loadConfig() {
    try {
      const raw = await fsp.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.config = this.normalizeConfig(parsed);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[voice-tts] config.json could not be read, using defaults');
      this.config = { ...DEFAULT_CONFIG, voices: { ...DEFAULT_CONFIG.voices } };
    }
    await this.writeConfig().catch(() => {});
  }

  /**
   * Coerce arbitrary persisted data into the supported config shape.
   * @param {unknown} parsed
   */
  normalizeConfig(parsed) {
    const config = { ...DEFAULT_CONFIG, voices: { ...DEFAULT_CONFIG.voices } };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return config;
    const source = /** @type {Record<string, unknown>} */ (parsed);
    if (typeof source.engine === 'string' && SERVER_ENGINES.includes(source.engine)) config.engine = source.engine;
    if (typeof source.rate === 'number' && Number.isFinite(source.rate)) {
      config.rate = Math.min(RATE_MAX, Math.max(RATE_MIN, source.rate));
    }
    if (typeof source.pitch === 'number' && Number.isFinite(source.pitch)) {
      config.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, source.pitch));
    }
    if (source.voices && typeof source.voices === 'object' && !Array.isArray(source.voices)) {
      const voices = /** @type {Record<string, unknown>} */ (source.voices);
      for (const lang of LANGUAGES) {
        const value = voices[lang];
        const allowed = [...EDGE_VOICES[lang], ...SAPI_VOICES[lang]];
        if (typeof value === 'string' && allowed.includes(value)) config.voices[lang] = value;
        else config.voices[lang] = null;
      }
    }
    return config;
  }

  /** Atomically persist the current config (temp file + rename). */
  async writeConfig() {
    const body = `${JSON.stringify({ ...this.config, version: 1, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    const temp = `${this.configPath}.${randomUUID()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
      await fsp.writeFile(temp, body, 'utf8');
      await fsp.rename(temp, this.configPath);
      this.persistedAt = Date.now();
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      if (this.persistedAt === 0) console.warn('[voice-tts] config.json could not be written:', messageOf(error));
    }
  }

  /** Debounced debounced config persist used after successful synthesis. */
  schedulePersist() {
    if (this.disposed || this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.writeConfig();
    }, 1000);
    if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
  }

  // ── python detection / prepare ────────────────────────────────────────────

  /**
   * Locate a usable Python 3.10+ interpreter.
   * Order: `DSH_VOICE_PYTHON` → venv → `py -3.12` → bundled DSH runtime →
   * `py -3` → `python` → `python3`. Result cached for 30 s.
   * @returns {Promise<{command: string, args: string[], version: string, label: string, runtime: string} | null>}
   */
  async detectPython() {
    if (Date.now() - this.pythonCache.at < 30_000) return this.pythonCache.value;
    const candidates = [];
    const configured = process.env.DSH_VOICE_PYTHON;
    if (typeof configured === 'string' && configured.trim() !== '') {
      candidates.push({ label: 'DSH_VOICE_PYTHON', command: configured.trim(), args: ['--version'] });
    }
    const venvPython = this.venvPythonPath();
    if (existsSync(venvPython)) {
      candidates.push({ label: 'venv', command: venvPython, args: ['--version'] });
    }
    candidates.push({ label: 'py -3.12', command: 'py', args: ['-3.12', '--version'] });
    const runtimePython = path.join(
      os.homedir(),
      '.dsh',
      'dsh-runtimes',
      'dsh-primary-runtime',
      'dependencies',
      'python',
      process.platform === 'win32' ? 'python.exe' : 'python',
    );
    if (existsSync(runtimePython)) candidates.push({ label: 'dsh runtime', command: runtimePython, args: ['--version'] });
    candidates.push({ label: 'py -3', command: 'py', args: ['-3', '--version'] });
    candidates.push({ label: 'python', command: 'python', args: ['--version'] });
    if (process.platform !== 'win32') candidates.push({ label: 'python3', command: 'python3', args: ['--version'] });

    for (const candidate of candidates) {
      if (process.platform === 'win32' && !candidate.command.endsWith('.exe') && path.sep === '\\') {
        // Command shims (`py`, `python`) are resolved by the shell/execFile PATH
        // search; nothing to do here, kept explicit for readability.
      }
      const result = await runProcess(candidate.command, candidate.args, { timeoutMs: 10_000 });
      if (!result.ok) continue;
      const version = parsePythonVersion(result.stdout, result.stderr);
      if (!version) continue;
      if (version.major !== 3 || version.minor < 10) continue;
      const value = {
        command: candidate.command,
        args: candidate.args.slice(0, -1),
        version: version.text,
        label: candidate.label,
        runtime: candidate.command === runtimePython ? 'dsh-runtime' : candidate.label,
      };
      this.pythonCache = { at: Date.now(), value };
      return value;
    }
    this.pythonCache = { at: Date.now(), value: null };
    return null;
  }

  /** @returns {{at: number, value: any}} Cached SAPI voice list. */
  get sapiAvailable() {
    return process.platform === 'win32';
  }

  /** True when the venv interpreter and the `edge_tts` package exist. */
  edgePrepared() {
    if (!existsSync(this.venvPythonPath())) return false;
    const site = path.join(this.venvDir, 'Lib', 'site-packages', 'edge_tts');
    if (existsSync(site)) return true;
    const libDir = path.join(this.venvDir, 'lib');
    try {
      for (const entry of readdirSync(libDir)) {
        if (existsSync(path.join(libDir, entry, 'site-packages', 'edge_tts'))) return true;
      }
    } catch {
      /* not a unix venv layout */
    }
    return false;
  }

  /** Snapshot of the prepare job (public shape). */
  prepareSnapshot() {
    const state = this.prepareState;
    return {
      running: state.running,
      phase: state.phase,
      progress: Math.min(1, Math.max(0, state.progress)),
      message: state.message,
      error: state.error,
      installedVersion: state.installedVersion,
      prepared: this.edgePrepared(),
    };
  }

  /** @param {string} phase @param {number} progress @param {string} message */
  setPhase(phase, progress, message) {
    this.prepareState.phase = phase;
    this.prepareState.progress = progress;
    this.prepareState.message = message;
  }

  /** @param {string} phase @param {string} message End the prepare job. */
  finishPrepare(phase, message) {
    const state = this.prepareState;
    state.running = false;
    state.phase = phase;
    state.progress = phase === 'ready' ? 1 : state.progress;
    state.message = message;
    state.error = phase === 'error' ? message : null;
    state.finishedAt = Date.now();
  }

  /** @returns {boolean} True when the prepare job was asked to stop. */
  get prepareCancelled() {
    return this.prepareState.cancelRequested;
  }

  /**
   * Start (or report) the edge runtime installation.
   * @param {Record<string, unknown>} body
   */
  async prepare(body) {
    if (body.engine !== undefined && body.engine !== null && body.engine !== 'edge') {
      throw badRequest('only the edge engine needs preparation (SAPI is already installed by Windows)');
    }
    if (this.prepareState.running) return { started: false, ...this.prepareSnapshot() };
    this.prepareState = {
      running: true,
      phase: 'check',
      progress: 0.01,
      message: 'checking the Python runtime',
      error: null,
      startedAt: Date.now(),
      finishedAt: 0,
      cancelRequested: false,
      installedVersion: null,
    };
    this.prepareTask = this.runPrepare().catch((error) => {
      this.finishPrepare('error', `preparation failed: ${messageOf(error)}`);
    });
    return { started: true, ...this.prepareSnapshot() };
  }

  /** The prepare pipeline: check → venv → pip → verify → worker → ready. */
  async runPrepare() {
    const fail = (message) => {
      this.finishPrepare('error', message);
    };
    try {
      if (this.edgePrepared()) {
        this.setPhase('verify', 0.9, 'edge runtime already installed');
        const version = await this.verifyEdge();
        this.prepareState.installedVersion = version;
        this.finishPrepare('ready', 'edge runtime ready');
        return;
      }
      if (this.prepareCancelled) return this.finishPrepare('cancelled', 'preparation cancelled');

      this.setPhase('check', 0.05, 'locating Python 3.10+');
      const python = await this.detectPython();
      if (!python) {
        return fail('Python 3.10+ was not found. Install Python or set DSH_VOICE_PYTHON to its executable.');
      }
      if (this.prepareCancelled) return this.finishPrepare('cancelled', 'preparation cancelled');

      this.setPhase('venv', 0.2, `creating the virtual environment (Python ${python.version})`);
      const venvPython = this.venvPythonPath();
      if (!existsSync(venvPython)) {
        const created = await this.runLogged(python.command, [...python.args, '-m', 'venv', this.venvDir], {
          timeoutMs: VENV_TIMEOUT_MS,
        });
        if (!created.ok || !existsSync(venvPython)) {
          return fail(`could not create the Python virtual environment: ${this.tailOf(created)}`);
        }
      }
      if (this.prepareCancelled) return this.finishPrepare('cancelled', 'preparation cancelled');

      this.setPhase('pip', 0.45, 'installing edge-tts (this can take a minute)');
      const pip = await this.runLogged(
        venvPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', this.requirementsPath],
        { timeoutMs: PIP_TIMEOUT_MS, trackChild: true, logName: 'pip.log' },
      );
      if (this.prepareCancelled || pip.cancelled) return this.finishPrepare('cancelled', 'preparation cancelled');
      if (!pip.ok) return fail(`pip install failed: ${this.tailOf(pip)}`);

      this.setPhase('verify', 0.8, 'verifying the neural runtime');
      const version = await this.verifyEdge();
      if (version === null) return fail('edge-tts could not be imported after installation');
      this.prepareState.installedVersion = version;

      this.setPhase('worker', 0.9, 'starting the neural worker');
      try {
        await this.worker.request('ping', {}, EDGE_PING_TIMEOUT_MS);
      } catch (error) {
        return fail(`the neural worker did not start: ${messageOf(error)}`);
      }
      this.finishPrepare('ready', 'edge runtime ready');
    } catch (error) {
      fail(`preparation failed: ${messageOf(error)}`);
    }
  }

  /**
   * Import `edge_tts` inside the venv and return its version.
   * @returns {Promise<string | null>}
   */
  async verifyEdge() {
    const result = await runProcess(this.venvPythonPath(), ['-c', 'import edge_tts; print(edge_tts.__version__)'], {
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    if (!result.ok) return null;
    const version = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    return version === '' ? null : version;
  }

  /** @param {{stdout: string, stderr: string}} result @returns {string} */
  tailOf(result) {
    const text = `${result.stderr || ''}${result.stdout || ''}`.trim();
    return text.length > 400 ? `…${text.slice(-400)}` : text || 'no diagnostic output';
  }

  /**
   * Spawn one long child (venv/pip), optionally tracked for cancellation and
   * appended to a log file.
   * @param {string} command @param {string[]} args
   * @param {{timeoutMs: number, trackChild?: boolean, logName?: string}} options
   * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string, cancelled: boolean}>}
   */
  runLogged(command, args, options) {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (options.trackChild) this.pipChild = child;
      let stdout = '';
      let stderr = '';
      let cancelled = false;
      let done = false;
      const timer = setTimeout(() => {
        cancelled = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, options.timeoutMs);
      const finish = (ok, code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (options.trackChild && this.pipChild === child) this.pipChild = null;
        if (options.logName) {
          void appendLog(this.logsDir, `$ ${command} ${args.join(' ')}\n${stdout}${stderr}\n(exit ${code}${cancelled ? ', cancelled' : ''})\n`);
        }
        resolve({ ok: ok && !cancelled, code, stdout, stderr, cancelled });
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-65_536);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-65_536);
      });
      child.once('error', (error) => {
        stderr += messageOf(error);
        finish(false, -1);
      });
      child.once('exit', (code) => finish(code === 0, typeof code === 'number' ? code : -1));
    });
  }

  // ── SAPI ──────────────────────────────────────────────────────────────────

  /**
   * List installed SAPI voices (cached for 60 s).
   * @param {boolean} [force]
   * @returns {Promise<Array<{name: string, culture: string, gender: string, age: string}>>}
   */
  async listSapiVoices(force = false) {
    if (!this.sapiAvailable) return [];
    if (!force && Date.now() - this.sapiCache.at < 60_000) return this.sapiCache.value;
    try {
      const result = await runProcess(
        this.powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.sapiScript, '-ListVoices'],
        { timeoutMs: 20_000 },
      );
      let parsed = null;
      if (result.ok && result.stdout.trim() !== '') parsed = JSON.parse(result.stdout.trim());
      const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      const voices = rows
        .filter((row) => row && typeof row.name === 'string' && row.name !== '')
        .map((row) => ({
          name: row.name,
          culture: typeof row.culture === 'string' ? row.culture : '',
          gender: typeof row.gender === 'string' ? row.gender : '',
          age: typeof row.age === 'string' ? row.age : '',
        }));
      this.sapiCache = { at: Date.now(), value: voices };
    } catch {
      this.sapiCache = { at: Date.now(), value: [] };
    }
    return this.sapiCache.value;
  }

  /**
   * Render one WAV through `System.Speech` (offline). The text goes through a
   * UTF-8 file, never through the command line.
   * @param {{text: string, voice: string, rate: number, out: string}} job
   */
  async synthesizeSapi(job) {
    if (!this.sapiAvailable) throw internal('SAPI is only available on Windows');
    const textFile = path.join(this.logsDir, `sapi-${randomUUID()}.txt`);
    await fsp.mkdir(this.logsDir, { recursive: true });
    await fsp.writeFile(textFile, job.text, 'utf8');
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.sapiScript,
      '-TextFile',
      textFile,
      '-OutFile',
      job.out,
      '-Rate',
      String(sapiRateValue(job.rate)),
      '-Volume',
      '100',
    ];
    if (job.voice) args.push('-Voice', job.voice);
    try {
      const result = await runProcess(this.powershellPath(), args, { timeoutMs: SAPI_TIMEOUT_MS });
      if (!result.ok) {
        throw internal(`SAPI synthesis failed: ${this.tailOf(result)}`);
      }
    } finally {
      await fsp.rm(textFile, { force: true }).catch(() => {});
    }
  }

  // ── voices / engines ──────────────────────────────────────────────────────

  /**
   * Closed voice catalog per language for both server engines.
   * @returns {Promise<Record<string, {label: string, engines: Record<string, Array<{id: string, label: string, installed: boolean}>>}>>}
   */
  async voiceCatalog() {
    const sapiVoices = await this.listSapiVoices();
    const catalog = {};
    for (const lang of LANGUAGES) {
      const sapiInstalled = sapiVoices.filter((voice) => sameLang(voice.culture, lang));
      // Preferred names can alias the same installed voice (e.g. "Microsoft
      // Maria" vs "Microsoft Maria Desktop"): keep one entry per spoken label,
      // preferring the installed spelling.
      const byLabel = new Map();
      for (const voiceName of SAPI_VOICES[lang]) {
        const label = sapiVoiceLabel(voiceName);
        const installed = sapiInstalled.some((voice) => voice.name === voiceName);
        const key = label.toLowerCase();
        const existing = byLabel.get(key);
        if (existing === undefined || (!existing.installed && installed)) {
          byLabel.set(key, { id: voiceName, label, installed });
        }
      }
      catalog[lang] = {
        label: lang === 'pt-BR' ? 'Português (Brasil)' : 'English (US)',
        engines: {
          edge: EDGE_VOICES[lang].map((id) => ({ id, label: edgeVoiceLabel(id), installed: true })),
          sapi: Array.from(byLabel.values()),
        },
      };
    }
    return catalog;
  }

  /** @param {Record<string, unknown>} body */
  async voices(body) {
    const catalog = await this.voiceCatalog();
    if (body.lang === undefined || body.lang === null) return catalog;
    const lang = normalizeLang(body.lang);
    return { [lang]: catalog[lang] };
  }

  /**
   * Resolve the ordered engine plans for one request.
   * @param {'auto' | 'edge' | 'sapi'} enginePreference
   * @param {'pt-BR' | 'en-US'} lang
   * @param {string | undefined} requestedVoice
   * @returns {Array<{engine: 'edge' | 'sapi', voice: string, lang: string}>}
   */
  resolvePlans(enginePreference, lang, requestedVoice) {
    const edges = EDGE_VOICES[lang];
    const sapi = SAPI_VOICES[lang];
    const everything = [...edges, ...sapi];
    if (requestedVoice !== undefined && !everything.includes(requestedVoice)) {
      throw badRequest(`voice not supported for ${lang}: ${requestedVoice}`, { voices: everything });
    }
    const engines = enginePreference === 'auto' ? ['edge', 'sapi'] : [enginePreference];
    /** @type {Array<{engine: 'edge' | 'sapi', voice: string, lang: string}>} */
    const plans = [];
    for (const engine of engines) {
      const allowed = engine === 'edge' ? edges : sapi;
      let voice;
      if (requestedVoice !== undefined) {
        if (!allowed.includes(requestedVoice)) continue;
        voice = requestedVoice;
      } else {
        const configured = this.config.voices[lang];
        voice = configured && allowed.includes(configured) ? configured : allowed[0];
      }
      plans.push({ engine, voice, lang });
    }
    return plans;
  }

  // ── cache ─────────────────────────────────────────────────────────────────

  /** @returns {Promise<{files: number, bytes: number}>} */
  async cacheStats() {
    let files = 0;
    let bytes = 0;
    try {
      const names = await fsp.readdir(this.cacheDir);
      for (const entry of names) {
        if (entry.startsWith('tmp-')) continue;
        try {
          const stat = await fsp.stat(path.join(this.cacheDir, entry));
          if (stat.isFile()) {
            files += 1;
            bytes += stat.size;
          }
        } catch {
          /* raced with pruning */
        }
      }
    } catch {
      /* cache directory absent */
    }
    return { files, bytes };
  }

  /** Debounced prune after a cache write. */
  schedulePrune() {
    if (this.pruneTimer !== null) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      void this.pruneCache('write');
    }, 5000);
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
  }

  /**
   * Enforce the cache budget (oldest files first) and clear stale temp files.
   * @param {string} _reason
   */
  async pruneCache(_reason) {
    if (this.pruning) {
      this.pruneAgain = true;
      return;
    }
    this.pruning = true;
    try {
      const names = await fsp.readdir(this.cacheDir);
      /** @type {Array<{path: string, size: number, mtime: number}>} */
      const files = [];
      for (const entry of names) {
        const entryPath = path.join(this.cacheDir, entry);
        try {
          const stat = await fsp.stat(entryPath);
          if (!stat.isFile()) continue;
          if (entry.startsWith('tmp-')) {
            if (Date.now() - stat.mtimeMs > CACHE_TEMP_TTL_MS) await fsp.rm(entryPath, { force: true });
            continue;
          }
          files.push({ path: entryPath, size: stat.size, mtime: stat.mtimeMs });
        } catch {
          /* raced */
        }
      }
      files.sort((a, b) => a.mtime - b.mtime);
      let total = files.reduce((sum, file) => sum + file.size, 0);
      let count = files.length;
      for (const file of files) {
        if (count <= CACHE_MAX_FILES && total <= CACHE_MAX_BYTES) break;
        await fsp.rm(file.path, { force: true }).catch(() => {});
        total -= file.size;
        count -= 1;
      }
    } catch {
      /* cache directory absent */
    } finally {
      this.pruning = false;
      if (this.pruneAgain) {
        this.pruneAgain = false;
        this.schedulePrune();
      }
    }
  }

  // ── synthesis ─────────────────────────────────────────────────────────────

  /**
   * Read one cached audio file, if present.
   * @param {string} filePath
   * @returns {Promise<Buffer | null>}
   */
  async readCachedAudio(filePath) {
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size < AUDIO_MIN_BYTES) return null;
      return await fsp.readFile(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Render (or reuse) one audio file for a resolved plan.
   * @param {{engine: 'edge' | 'sapi', voice: string, lang: string}} plan
   * @param {{text: string, rate: number, pitch: number}} request
   * @param {{aborted?: boolean, onAbort?: (fn: () => void) => void}} [signal]
   * @returns {Promise<{buffer: Buffer, cached: boolean, voice: string, mime: string}>}
   */
  async render(plan, request, signal) {
    const key = cacheKey({ engine: plan.engine, voice: plan.voice, rate: request.rate, pitch: request.pitch, text: request.text });
    const extension = plan.engine === 'edge' ? 'mp3' : 'wav';
    const mime = plan.engine === 'edge' ? MIME_EDGE : MIME_SAPI;
    const finalPath = path.join(this.cacheDir, `${key}.${extension}`);
    await fsp.mkdir(this.cacheDir, { recursive: true });

    const cached = await this.readCachedAudio(finalPath);
    if (cached) return { buffer: cached, cached: true, voice: plan.voice, mime };

    const tempPath = path.join(this.cacheDir, `tmp-${key}-${randomUUID()}.${extension}`);
    try {
      if (signal?.aborted) throw internal('cancelled');
      if (plan.engine === 'edge') {
        await this.worker.synthesize({
          text: request.text,
          voice: plan.voice,
          rate: edgeRateString(request.rate),
          pitch: edgePitchString(request.pitch),
          out: tempPath,
        });
      } else {
        const sapiVoice = await this.pickSapiVoice(plan.voice, plan.lang);
        await this.synthesizeSapi({ text: request.text, voice: sapiVoice, rate: request.rate, out: tempPath });
        plan.voice = sapiVoice;
      }
      const buffer = await fsp.readFile(tempPath);
      if (buffer.length < AUDIO_MIN_BYTES) throw internal('synthesis produced an empty audio file');
      this.assertAudioFormat(buffer, plan.engine);
      await fsp.rename(tempPath, finalPath).catch(async () => {
        await fsp.rm(finalPath, { force: true }).catch(() => {});
        await fsp.rename(tempPath, finalPath);
      });
      this.schedulePrune();
      return { buffer, cached: false, voice: plan.voice, mime };
    } finally {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Pick the installed SAPI voice closest to the requested one.
   * @param {string} requested @param {string} lang
   * @returns {Promise<string>}
   */
  async pickSapiVoice(requested, lang) {
    const installed = await this.listSapiVoices();
    const sameLanguage = installed.filter((voice) => sameLang(voice.culture, lang));
    if (sameLanguage.some((voice) => voice.name === requested)) return requested;
    const preferred = SAPI_VOICES[lang].find((voiceName) => sameLanguage.some((voice) => voice.name === voiceName));
    return preferred ?? sameLanguage[0]?.name ?? requested;
  }

  /**
   * Cheap container sanity check.
   * @param {Buffer} buffer @param {'edge' | 'sapi'} engine
   */
  assertAudioFormat(buffer, engine) {
    if (engine === 'sapi') {
      const riff = buffer.toString('ascii', 0, 4);
      const wave = buffer.toString('ascii', 8, 12);
      if (riff !== 'RIFF' || wave !== 'WAVE') throw internal('SAPI returned a file that is not a WAV');
      return;
    }
    const id3 = buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33;
    const frame = buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
    if (!id3 && !frame) throw internal('edge returned a file that is not an MP3');
  }

  /**
   * Synthesize one request with engine preference/fallback.
   * @param {Record<string, unknown>} body
   * @param {AbortSignal | undefined} [signal]
   */
  async synthesize(body, signal) {
    const text = sanitizeText(body.text);
    const lang = normalizeLang(body.lang);
    const rate = readNumber(body.rate, this.config.rate, RATE_MIN, RATE_MAX, 'rate');
    const pitch = readNumber(body.pitch, this.config.pitch, PITCH_MIN, PITCH_MAX, 'pitch');
    const enginePreference = normalizeEngine(body.engine);
    let requestedVoice;
    if (body.voice !== undefined && body.voice !== null && body.voice !== '') {
      if (typeof body.voice !== 'string') throw badRequest('voice must be a string');
      requestedVoice = body.voice.trim();
    }
    const plans = this.resolvePlans(enginePreference, lang, requestedVoice);
    if (plans.length === 0) {
      throw badRequest(`no engine can render ${lang}${requestedVoice ? ` with voice ${requestedVoice}` : ''}`, {
        engine: enginePreference,
      });
    }

    /** @type {Array<{engine: string, message: string}>} */
    const failures = [];
    for (const plan of plans) {
      if (signal?.aborted) throw internal('cancelled');
      const readiness = await this.engineReady(plan.engine);
      if (!readiness.ok) {
        failures.push({ engine: plan.engine, message: readiness.reason });
        continue;
      }
      try {
        const rendered = await this.render(plan, { text, rate, pitch }, signal);
        this.rememberPreferences(plan, lang, rate, pitch);
        return {
          audioBase64: rendered.buffer.toString('base64'),
          mime: rendered.mime,
          engine: plan.engine,
          voice: rendered.voice,
          cached: rendered.cached,
          bytes: rendered.buffer.length,
        };
      } catch (error) {
        if (error instanceof TtsError && error.code === 'bad-request') throw error;
        if (signal?.aborted) throw internal('cancelled');
        failures.push({ engine: plan.engine, message: messageOf(error) });
      }
    }
    const summary = failures.map((failure) => `${failure.engine}: ${failure.message}`).join('; ');
    throw internal(`synthesis failed (${summary})`, { failures });
  }

  /**
   * @param {'edge' | 'sapi'} engine
   * @returns {Promise<{ok: boolean, reason: string}>}
   */
  async engineReady(engine) {
    if (engine === 'edge') {
      if (this.edgePrepared()) return { ok: true, reason: '' };
      return { ok: false, reason: 'edge runtime is not prepared; call prepare (online neural voices)' };
    }
    if (engine === 'sapi') {
      if (this.sapiAvailable) return { ok: true, reason: '' };
      return { ok: false, reason: 'SAPI is only available on Windows' };
    }
    return { ok: false, reason: `unknown engine ${engine}` };
  }

  /**
   * Persist the last successful options (debounced).
   * @param {{engine: string, voice: string}} plan
   * @param {string} lang @param {number} rate @param {number} pitch
   */
  rememberPreferences(plan, lang, rate, pitch) {
    this.config.rate = rate;
    this.config.pitch = pitch;
    this.config.voices[lang] = plan.voice;
    this.config.engine = plan.engine;
    this.schedulePersist();
  }

  // ── endpoints ─────────────────────────────────────────────────────────────

  /** @returns {Promise<Record<string, unknown>>} */
  async status() {
    const python = await this.detectPython().catch(() => null);
    const sapiVoices = await this.listSapiVoices();
    const cache = await this.cacheStats();
    return {
      plugin: { name: 'dsh-tts', version: PLUGIN_VERSION, channel: CHANNEL },
      platform: process.platform,
      home: this.ttsRoot,
      languages: LANGUAGES,
      engines: {
        edge: {
          available: true,
          prepared: this.edgePrepared(),
          online: true,
          installing: this.prepareState.running,
          python: python ? { found: true, label: python.label, version: python.version } : { found: false, version: null },
          voices: Object.fromEntries(LANGUAGES.map((lang) => [lang, EDGE_VOICES[lang]])),
        },
        sapi: {
          available: this.sapiAvailable,
          voices: sapiVoices,
        },
        browser: { available: true, client: true },
      },
      voices: await this.voiceCatalog(),
      defaults: {
        engine: this.config.engine,
        rate: this.config.rate,
        pitch: this.config.pitch,
        voices: this.config.voices,
      },
      cache: { ...cache, maxFiles: CACHE_MAX_FILES, maxBytes: CACHE_MAX_BYTES },
      limits: {
        textMax: TEXT_MAX_CHARS,
        rateMin: RATE_MIN,
        rateMax: RATE_MAX,
        pitchMin: PITCH_MIN,
        pitchMax: PITCH_MAX,
      },
      prepare: this.prepareSnapshot(),
    };
  }

  /** Cancel any in-flight synthesis/prepare and stop the worker. */
  async cancel() {
    this.prepareState.cancelRequested = true;
    if (this.prepareState.running) {
      this.prepareState.message = 'cancelling preparation';
      this.prepareState.phase = 'cancelled';
    }
    this.worker.kill();
    if (this.pipChild) {
      try {
        this.pipChild.kill();
      } catch {
        /* already gone */
      }
      this.pipChild = null;
    }
    return { cancelled: true, at: new Date().toISOString() };
  }

  /**
   * Dispatch one RPC call; every error is normalized here.
   * @param {string} endpoint
   * @param {unknown} payload
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: true, value: unknown} | {ok: false, error: {code: string, message: string, details: Record<string, unknown>}}>}
   */
  async rpc(endpoint, payload, signal) {
    try {
      const value = await this.dispatch(endpoint, payload, signal);
      return { ok: true, value };
    } catch (error) {
      if (error instanceof TtsError) {
        return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
      }
      const message = messageOf(error);
      console.error('[voice-tts] unexpected failure:', message);
      return { ok: false, error: { code: 'internal', message, details: {} } };
    }
  }

  /**
   * @param {string} endpoint
   * @param {unknown} payload
   * @param {AbortSignal} [signal]
   */
  async dispatch(endpoint, payload, signal) {
    if (typeof endpoint !== 'string' || endpoint === '') throw badRequest('endpoint must be a non-empty string');
    await this.bootPromise;
    if (this.disposed) throw internal('plugin is shutting down');
    const body = payload === undefined || payload === null ? {} : payload;
    if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('payload must be an object');
    /** @type {Record<string, unknown>} */
    const fields = /** @type {Record<string, unknown>} */ (body);
    switch (endpoint) {
      case 'status':
        return this.status();
      case 'voices':
        return this.voices(fields);
      case 'prepare':
        return this.prepare(fields);
      case 'prepareStatus':
        return this.prepareSnapshot();
      case 'synthesize':
        return this.synthesize(fields, signal);
      case 'cancel':
        return this.cancel();
      default:
        throw badRequest(`unknown endpoint: ${endpoint}`);
    }
  }
}

// ── Cordis plumbing ─────────────────────────────────────────────────────────

/**
 * True for the platform's service-resolution failure
 * (`cannot get property "X" without inject`), walking the `cause` chain because
 * the loader may re-wrap boot errors.
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingInject(error) {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (String(current.message).includes('without inject')) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Register the `/voice-tts` RPC channel on the connection service.
 *
 * The documented `ctx.connection.rpc.handle(channel, handler)` delegates to the
 * registry with the *connection plugin's own* context as owner; on this DSH
 * build that owner fiber cannot see `webServer`, so the call throws for plugin
 * rows that are siblings of the webserver row. The registry method takes the
 * owning context as its first argument, so retry it with this plugin's own
 * inject-resolved ctx: same prefix route, same trust fence, same envelope. The
 * fallback only handles that one resolution error, and only while the registry
 * method exists.
 *
 * @param {import('cordis').Context} ctx
 * @param {string} channel
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => unknown} handler
 * @returns {() => void}
 */
export function registerRpcChannel(ctx, channel, handler) {
  const connection = ctx.connection;
  try {
    return connection.rpc.handle(channel, handler);
  } catch (error) {
    if (!isMissingInject(error) || typeof connection.register !== 'function') throw error;
    return connection.register(ctx, channel, handler);
  }
}

/**
 * Cordis entry point: register the RPC channel and return a disposer that
 * stops workers, cancels preparation and clears timers.
 * @param {import('cordis').Context} ctx
 * @returns {() => void}
 */
export function apply(ctx) {
  const service = new TtsService(ctx);
  const disposeRpc = registerRpcChannel(ctx, CHANNEL, (endpoint, payload, signal) =>
    service.rpc(endpoint, payload, signal),
  );
  console.log(`[voice-tts] /voice-tts ready (home: ${service.ttsRoot})`);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      disposeRpc();
    } catch {
      /* channel already gone */
    }
    service.dispose();
  };
}

/**
 * Internals exposed for unit tests only (not part of the client contract).
 */
export const __internals = Object.freeze({
  CHANNEL,
  PLUGIN_VERSION,
  TEXT_MAX_CHARS,
  RATE_MIN,
  RATE_MAX,
  PITCH_MIN,
  PITCH_MAX,
  CACHE_MAX_FILES,
  CACHE_MAX_BYTES,
  EDGE_VOICES,
  SAPI_VOICES,
  LANGUAGES,
  DEFAULT_CONFIG,
  TtsService,
  TtsError,
  EdgeWorker,
  sanitizeText,
  normalizeLang,
  normalizeEngine,
  readNumber,
  edgeRateString,
  edgePitchString,
  sapiRateValue,
  cacheKey,
  parsePythonVersion,
  voiceHome,
  registerRpcChannel,
});
