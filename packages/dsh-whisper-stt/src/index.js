/**
 * dsh-whisper-stt — server half.
 *
 * A Cordis plugin that powers local Whisper dictation in the DSH composer:
 *   - RPC channel `/voice-stt` registered through the `connection` service, so
 *     the platform's browser fence (loopback Host + same-origin + session
 *     cookie) guards it. Endpoints: status, prepare, prepareStatus, transcribe,
 *     cancel, setConfig.
 *   - A persistent Python worker (`runtime/worker.py`, JSON Lines over
 *     stdin/stdout) keeps the faster-whisper model loaded between dictations,
 *     falling back from CUDA to CPU automatically when CUDA/cuDNN is missing.
 *   - Idempotent `prepare` pipeline: venv → pip install → model download →
 *     model load → ready, with progress consumed by `prepareStatus`, logged to
 *     `<stt-home>/logs/`, and cancellable.
 *   - Configuration persisted atomically in `<stt-home>/config.json`.
 *
 * <stt-home> is `DSH_VOICE_HOME` (or `~/.dsh/dsh-voice`) joined with `stt`.
 * Audio never leaves the machine: the only network access is the one-time
 * model download from HuggingFace during `prepare`.
 *
 * Security model:
 *   - No client-supplied file path reaches the filesystem; audio arrives as
 *     strict base64 WAV and is validated (RIFF/PCM16/mono/16 kHz/duration/caps)
 *     before crossing into the worker.
 *   - Endpoint dispatch uses own-property lookup only (`__proto__`/
 *     `constructor` can never resolve), and handlers return only the two error
 *     codes the shared RPC schema knows: `bad-request` and `internal`.
 *   - Worker stdout is parsed as JSON only; anything else is logged, never
 *     evaluated.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name (also the client bundle loader id). */
export const name = 'whisper-stt';
/** Services required before this plugin can mount. */
export const inject = ['webServer', 'connection'];

/** RPC channel shared with `src/client.js` (no internal "/", per CHANNEL_PATTERN). */
const RPC_CHANNEL = '/voice-stt';
/** Package version, mirrored to the client bundle and the debug hook. */
const VERSION = readPackageVersion();
/** Models the contract allows and the Settings select exposes. */
const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];
const DEFAULT_MODEL = 'small';
/** Hard cap on decoded audio bytes (contract §3.7). */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
/** Hard cap on clip duration; the configurable default is 60 s. */
const MAX_AUDIO_SECONDS = 120;
const DEFAULT_MAX_AUDIO_SECONDS = 60;
const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKER_SCRIPT = fileURLToPath(new URL('../runtime/worker.py', import.meta.url));
const REQUIREMENTS_FILE = fileURLToPath(new URL('../runtime/requirements.txt', import.meta.url));

/** Config keys persisted in `<stt-home>/config.json`. */
const CONFIG_DEFAULTS = Object.freeze({
  model: DEFAULT_MODEL,
  language: 'auto',
  device: 'auto',
  /** `auto` installs the pip `nvidia-cublas-cu12` wheel when a GPU is present; `off` keeps CPU. */
  cudaLibs: 'auto',
  pythonPath: null,
  maxAudioSeconds: DEFAULT_MAX_AUDIO_SECONDS,
  idleShutdownMinutes: 10,
});
/** Pip package providing the cuBLAS runtime DLLs ctranslate2 needs on Windows. */
const CUDA_LIBS_PACKAGE = 'nvidia-cublas-cu12';

/** Business error carrier (converted to the RPC error branch at the boundary). */
class SttError extends Error {
  /**
   * @param {'bad-request'|'internal'} code error code allowed by the RPC schema
   * @param {string} message actionable, user-facing message
   * @param {Record<string, unknown>} [details] optional structured details
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SttError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} message @returns {SttError} */
const badRequest = (message, details) => new SttError('bad-request', message, details);
/** @param {string} message @returns {SttError} */
const internalError = (message, details) => new SttError('internal', message, details);

/** Success branch of the RPC envelope. */
const ok = (value) => ({ ok: true, value });
/** Error branch of the RPC envelope; unknown failures collapse to `internal`. */
const fail = (error) =>
  error instanceof SttError
    ? { ok: false, error: { code: error.code, message: error.message, details: error.details } }
    : { ok: false, error: { code: 'internal', message: String(error?.message ?? error), details: {} } };

// ── paths ────────────────────────────────────────────────────────────────────

/** Root data directory for the voice suite (`DSH_VOICE_HOME` wins). */
function dataHome() {
  const override = process.env.DSH_VOICE_HOME;
  return override && override.trim() !== '' ? override : join(homedir(), '.dsh', 'dsh-voice');
}

/** STT-specific data directory (`<data-home>/stt`). */
function sttHome() {
  return join(dataHome(), 'stt');
}

/** All runtime paths, resolved from the environment at call time. */
function paths() {
  const home = sttHome();
  return {
    home,
    venv: join(home, 'venv'),
    models: join(home, 'models'),
    logs: join(home, 'logs'),
    workerLog: join(home, 'logs', 'worker.log'),
    setupLog: join(home, 'logs', 'setup.log'),
    configFile: join(home, 'config.json'),
  };
}

/** Interpreter inside the managed venv (created by `prepare`). */
function venvPython() {
  const { venv } = paths();
  return process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
}

/**
 * DLL directories contributed by pip CUDA wheels (`nvidia-*`): Windows only
 * finds `cublas64_12.dll` there when the directory is on the child's PATH.
 * @returns {string[]} existing directories, outermost first
 */
function cudaLibraryDirs() {
  const dirs = [];
  const { venv } = paths();
  const site = process.platform === 'win32' ? join(venv, 'Lib', 'site-packages') : join(venv, 'lib');
  try {
    const nvidia = join(site, 'nvidia');
    if (!existsSync(nvidia)) return dirs;
    for (const entry of readdirSync(nvidia, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const sub of ['bin', 'lib']) {
        const dir = join(nvidia, entry.name, sub);
        if (existsSync(dir)) dirs.push(dir);
      }
    }
  } catch {
    /* best effort: PATH augmentation must never break the worker spawn */
  }
  return dirs;
}

/** True when the pip-installed cuBLAS runtime is present in the venv. */
function cudaLibsInstalled() {
  return cudaLibraryDirs().some((dir) => existsSync(join(dir, 'cublas64_12.dll')) || existsSync(join(dir, 'libcublas.so.12')));
}

/** @returns {Promise<void>} create every runtime directory */
async function ensureDirs() {
  const { home, models, logs } = paths();
  await Promise.all([mkdir(home, { recursive: true }), mkdir(models, { recursive: true }), mkdir(logs, { recursive: true })]);
}

/** Read the package version without importing JSON modules (used by the debug hook). */
function readPackageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

// ── small utilities ─────────────────────────────────────────────────────────

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} text @param {number} max @returns {string} */
function truncate(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Last non-empty line of a chunk of process output. */
function lastLine(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.length > 0 ? lines[lines.length - 1].trim() : '';
}

/** True for a missing service error ("cannot get property X without inject"). */
function isMissingInject(error) {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (String(current.message).includes('without inject')) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Register the `/voice-stt` channel on the connection service.
 *
 * `ctx.connection.rpc.handle()` resolves `webServer` from the connection
 * plugin's own fiber, which fails for sibling plugins; the registry method is
 * retried with this plugin's inject-resolved ctx (proven pattern from the
 * reference explorer plugin against the same DSH build).
 *
 * @param {any} ctx plugin context
 * @param {string} channel channel name (`/voice-stt`)
 * @param {(endpoint: string, payload: unknown) => Promise<{ok: boolean}>} handler
 * @returns {() => void} disposer
 */
function registerRpcChannel(ctx, channel, handler) {
  const connection = ctx.connection;
  try {
    return connection.rpc.handle(channel, handler);
  } catch (error) {
    if (!isMissingInject(error) || typeof connection.register !== 'function') throw error;
    return connection.register(ctx, channel, handler);
  }
}

/**
 * Terminate a child process (and its tree on Windows) without leaking timers.
 * @param {import('node:child_process').ChildProcess | null} child
 */
function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
    } catch {
      /* best effort */
    }
  }, 1200);
  timer.unref?.();
}

/**
 * Run a short-lived process and collect its whole output.
 *
 * @param {string} command executable
 * @param {string[]} args arguments
 * @param {{timeoutMs?: number, env?: NodeJS.ProcessEnv, cwd?: string}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runProcess(command, args, options = {}) {
  const { timeoutMs = 30000, env = process.env, cwd } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(internalError(`não foi possível executar ${command}: ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminate(child);
      reject(internalError(`${command} excedeu ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-200000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-200000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(internalError(`falha ao executar ${command}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ── audio validation ────────────────────────────────────────────────────────

/**
 * Strict base64 decode (rejects junk instead of silently dropping bytes).
 * @param {string} text base64 payload without a data-URL prefix
 * @returns {Buffer}
 */
function decodeBase64(text) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw badRequest('audioBase64 inválido: esperado base64 sem prefixo data:');
  }
  return Buffer.from(compact, 'base64');
}

/**
 * Parse and validate the WAV contract: RIFF/WAVE, PCM (format 1), mono,
 * 16 kHz, 16-bit, with a non-empty data chunk.
 *
 * @param {Buffer} bytes WAV bytes
 * @returns {{durationSeconds: number, dataBytes: number, sampleRate: number}}
 */
function parseWave(bytes) {
  if (bytes.length < 44) throw badRequest('WAV inválido: arquivo muito curto');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw badRequest('WAV inválido: cabeçalho RIFF/WAVE ausente');
  }
  let offset = 12;
  let format = null;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > bytes.length) throw badRequest('WAV inválido: chunk truncado');
    if (id === 'fmt ') {
      if (size < 16) throw badRequest('WAV inválido: bloco fmt incompleto');
      format = {
        format: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataBytes = size;
    }
    offset = body + size + (size % 2);
  }
  if (!format) throw badRequest('WAV inválido: bloco fmt ausente');
  if (format.format !== 1) throw badRequest(`WAV inválido: esperado PCM (format 1), recebido ${format.format}`);
  if (format.channels !== 1) throw badRequest(`WAV inválido: esperado mono, recebido ${format.channels} canais`);
  if (format.sampleRate !== SAMPLE_RATE) {
    throw badRequest(`WAV inválido: esperado ${SAMPLE_RATE} Hz, recebido ${format.sampleRate} Hz`);
  }
  if (format.bits !== 16) throw badRequest(`WAV inválido: esperado PCM16, recebido ${format.bits} bits`);
  if (dataBytes <= 0) throw badRequest('WAV inválido: sem amostras de áudio');
  return {
    durationSeconds: dataBytes / BYTES_PER_SECOND,
    dataBytes,
    sampleRate: format.sampleRate,
  };
}

/**
 * Normalize the dictation language to `auto`|`pt`|`en`.
 * @param {unknown} value client value (`auto`, `pt`, `en`, `pt-BR`, `en-US`, null)
 * @returns {'auto'|'pt'|'en'}
 */
function normalizeLanguage(value) {
  if (value === undefined || value === null || value === '') return 'auto';
  if (typeof value !== 'string') throw badRequest('language inválido: esperado "auto", "pt" ou "en"');
  const key = value.toLowerCase();
  if (key === 'auto') return 'auto';
  if (key === 'pt' || key === 'pt-br' || key === 'pt_br') return 'pt';
  if (key === 'en' || key === 'en-us' || key === 'en_us') return 'en';
  throw badRequest(`language não suportado: ${value} (use "auto", "pt" ou "en")`);
}

/** Validate a model id against the allowed list. */
function requireModel(value) {
  if (value === undefined || value === null || value === '') return CONFIG_DEFAULTS.model;
  if (typeof value !== 'string' || !MODELS.includes(value)) {
    throw badRequest(`model inválido: ${String(value)} (use ${MODELS.join(', ')})`);
  }
  return value;
}

// ── configuration ──────────────────────────────────────────────────────────

/** Tolerant normalization of a persisted/partial config object. */
function normalizeConfig(raw) {
  const source = isRecord(raw) ? raw : {};
  const merged = { ...CONFIG_DEFAULTS };
  if (typeof source.model === 'string' && MODELS.includes(source.model)) merged.model = source.model;
  if (source.language !== undefined) {
    try {
      merged.language = normalizeLanguage(source.language);
    } catch {
      merged.language = 'auto';
    }
  }
  if (source.device === 'auto' || source.device === 'cuda' || source.device === 'cpu') merged.device = source.device;
  if (source.cudaLibs === 'off' || source.cudaLibs === 'auto') merged.cudaLibs = source.cudaLibs;
  if (typeof source.pythonPath === 'string' && source.pythonPath.trim() !== '') merged.pythonPath = source.pythonPath.trim();
  const maxSeconds = Number(source.maxAudioSeconds);
  if (Number.isFinite(maxSeconds)) merged.maxAudioSeconds = Math.min(MAX_AUDIO_SECONDS, Math.max(1, Math.round(maxSeconds)));
  const idle = Number(source.idleShutdownMinutes);
  if (Number.isFinite(idle)) merged.idleShutdownMinutes = Math.min(120, Math.max(1, Math.round(idle)));
  return merged;
}

/** Validate a `setConfig` patch, rejecting values outside the contract. */
function validateConfigPatch(payload) {
  if (!isRecord(payload)) throw badRequest('payload inválido: esperado um objeto');
  const patch = {};
  if (payload.model !== undefined) patch.model = requireModel(payload.model);
  if (payload.language !== undefined) patch.language = normalizeLanguage(payload.language);
  if (payload.device !== undefined) {
    if (!['auto', 'cuda', 'cpu'].includes(payload.device)) throw badRequest('device inválido: use auto, cuda ou cpu');
    patch.device = payload.device;
  }
  if (payload.cudaLibs !== undefined) {
    if (payload.cudaLibs !== 'auto' && payload.cudaLibs !== 'off') throw badRequest('cudaLibs inválido: use auto ou off');
    patch.cudaLibs = payload.cudaLibs;
  }
  if (payload.pythonPath !== undefined) {
    if (payload.pythonPath === null || payload.pythonPath === '') patch.pythonPath = null;
    else if (typeof payload.pythonPath !== 'string' || !existsSync(payload.pythonPath)) {
      throw badRequest(`pythonPath inválido: arquivo não encontrado (${String(payload.pythonPath)})`);
    } else patch.pythonPath = payload.pythonPath;
  }
  if (payload.maxAudioSeconds !== undefined) {
    const value = Number(payload.maxAudioSeconds);
    if (!Number.isFinite(value) || value < 1 || value > MAX_AUDIO_SECONDS) {
      throw badRequest(`maxAudioSeconds inválido: use um inteiro entre 1 e ${MAX_AUDIO_SECONDS}`);
    }
    patch.maxAudioSeconds = Math.round(value);
  }
  if (payload.idleShutdownMinutes !== undefined) {
    const value = Number(payload.idleShutdownMinutes);
    if (!Number.isFinite(value) || value < 1 || value > 120) {
      throw badRequest('idleShutdownMinutes inválido: use um inteiro entre 1 e 120');
    }
    patch.idleShutdownMinutes = Math.round(value);
  }
  return patch;
}

// ── Python detection ───────────────────────────────────────────────────────

/** Python version acceptable for faster-whisper wheels. */
function parseVersion(output) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(output).trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: match[0] } : null;
}

/**
 * Candidate interpreters in contract order. Explicit overrides (env/config) are
 * always accepted; automatic candidates are restricted to 3.10–3.12 so a 3.13/
 * 3.14 install is never chosen silently (it has no tested ctranslate2 wheels).
 *
 * @param {{pythonPath?: string|null}} config
 * @returns {Array<{command: string, args: string[], source: string, explicit: boolean}>}
 */
function pythonCandidates(config) {
  const candidates = [];
  const explicitEnv = (process.env.DSH_VOICE_PYTHON || process.env.DSH_STT_PYTHON || '').trim();
  if (explicitEnv) candidates.push({ command: explicitEnv, args: [], source: 'DSH_VOICE_PYTHON', explicit: true });
  if (config?.pythonPath) candidates.push({ command: config.pythonPath, args: [], source: 'config.pythonPath', explicit: true });
  if (process.platform === 'win32') {
    for (const minor of ['3.12', '3.11', '3.10']) candidates.push({ command: 'py', args: [`-${minor}`], source: `py -${minor}`, explicit: false });
  }
  const runtimePython = dshRuntimePython();
  if (runtimePython) candidates.push({ command: runtimePython, args: [], source: 'runtime DSH', explicit: false });
  candidates.push({ command: 'python3', args: [], source: 'python3', explicit: false });
  candidates.push({ command: 'python', args: [], source: 'python', explicit: false });
  return candidates;
}

/** Known 3.12 interpreter shipped with the DSH runtime. */
function dshRuntimePython() {
  const candidates = [];
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON);
  const base = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python');
  candidates.push(process.platform === 'win32' ? join(base, 'python.exe') : join(base, 'bin', 'python3'));
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/**
 * Locate a usable Python interpreter (3.10–3.12 unless explicitly overridden).
 *
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {{fresh?: boolean}} [options] bypass the version cache
 * @returns {Promise<{command: string, args: string[], executable: string, version: string, source: string}>}
 */
async function detectPython(config, options = {}) {
  const cacheKey = `${config?.pythonPath ?? ''}|${process.env.DSH_VOICE_PYTHON ?? ''}|${process.env.DSH_STT_PYTHON ?? ''}`;
  if (!options.fresh && detectPython.cache && detectPython.cache.key === cacheKey && Date.now() - detectPython.cache.at < 60000) {
    return detectPython.cache.value;
  }
  const rejected = [];
  for (const candidate of pythonCandidates(config)) {
    try {
      const probe = await runProcess(candidate.command, [
        ...candidate.args,
        '-c',
        'import sys; print("%d.%d.%d" % sys.version_info[:3]); print(sys.executable)',
      ], { timeoutMs: 10000 });
      if (probe.code !== 0) {
        rejected.push(`${candidate.source}: indisponível`);
        continue;
      }
      const lines = probe.stdout.trim().split(/\r?\n/);
      const version = parseVersion(lines[0] ?? '');
      const executable = (lines[1] ?? '').trim() || candidate.command;
      if (!version) {
        rejected.push(`${candidate.source}: versão ilegível`);
        continue;
      }
      if (version.major !== 3 || version.minor < 10) {
        rejected.push(`${candidate.source}: Python ${version.text} é anterior a 3.10`);
        continue;
      }
      if (!candidate.explicit && version.minor > 12) {
        rejected.push(`${candidate.source}: Python ${version.text} sem wheels testadas de ctranslate2 (use 3.12 ou defina DSH_VOICE_PYTHON)`);
        continue;
      }
      const value = { command: candidate.command, args: candidate.args, executable, version: version.text, source: candidate.source };
      detectPython.cache = { key: cacheKey, at: Date.now(), value };
      return value;
    } catch {
      rejected.push(`${candidate.source}: não executou`);
    }
  }
  throw internalError(
    `Nenhum Python 3.10–3.12 utilizável encontrado. Instale o Python 3.12 ou aponte DSH_VOICE_PYTHON / config.pythonPath para ele. ` +
      `Tentativas: ${rejected.join('; ')}`,
  );
}

/** @type {{key: string, at: number, value: any} | null} */
detectPython.cache = null;

/** Invalidate detection/import caches after a prepare or config change. */
function invalidateCaches(state) {
  detectPython.cache = null;
  state.fwCache = null;
  state.cudaCache = null;
  state.statusCache = null;
}

/**
 * Check whether faster-whisper is importable inside the managed venv.
 * @param {any} state controller state
 * @param {{fresh?: boolean}} [options]
 * @returns {Promise<{ok: boolean, detail: string, versions?: Record<string, string>}>}
 */
async function inspectFasterWhisper(state, options = {}) {
  if (!options.fresh && state.fwCache && Date.now() - state.fwCache.at < 60000) return state.fwCache.value;
  const python = venvPython();
  let value;
  if (!existsSync(python)) {
    value = { ok: false, detail: 'venv ainda não criado (execute Preparar)' };
  } else {
    try {
      const probe = await runProcess(
        python,
        ['-c', 'import sys,faster_whisper,ctranslate2;print(faster_whisper.__version__+"|"+ctranslate2.__version__+"|"+"%d.%d.%d"%sys.version_info[:3])'],
        { timeoutMs: 60000 },
      );
      if (probe.code === 0) {
        const [fasterWhisper, ctranslate2, pythonVersion] = probe.stdout.trim().split('|');
        value = {
          ok: true,
          detail: `faster-whisper ${fasterWhisper} · ctranslate2 ${ctranslate2} · Python ${pythonVersion}`,
          versions: { fasterWhisper, ctranslate2, python: pythonVersion },
        };
      } else {
        value = { ok: false, detail: `import falhou: ${truncate(lastLine(probe.stderr) || 'erro desconhecido', 200)}` };
      }
    } catch (error) {
      value = { ok: false, detail: truncate(error.message, 200) };
    }
  }
  state.fwCache = { at: Date.now(), value };
  return value;
}

/**
 * Report the model cache state without importing Python.
 * @param {string} modelName model id
 * @returns {Promise<{installed: boolean, path: string|null, bytes: number}>}
 */
async function inspectModel(modelName) {
  const { models } = paths();
  if (!existsSync(models)) return { installed: false, path: null, bytes: 0 };
  let entries = [];
  try {
    entries = await readdir(models, { withFileTypes: true });
  } catch {
    return { installed: false, path: null, bytes: 0 };
  }
  const dir = entries.find((entry) => entry.isDirectory() && entry.name.includes(`faster-whisper-${modelName}`));
  if (!dir) return { installed: false, path: null, bytes: 0 };
  const base = join(models, dir.name);
  let bytes = 0;
  let installed = false;
  const walk = async (directory, depth) => {
    if (depth > 4) return;
    let children = [];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const full = join(directory, child.name);
      if (child.isDirectory()) await walk(full, depth + 1);
      else if (child.isFile()) {
        try {
          const info = await stat(full);
          bytes += info.size;
          if (child.name === 'model.bin') installed = true;
        } catch {
          /* ignore unreadable entries */
        }
      }
    }
  };
  await walk(base, 0);
  return { installed, path: base, bytes };
}

/**
 * Detect an NVIDIA GPU via nvidia-smi (cached; CUDA may still lack cuDNN, which
 * the worker reports when it falls back to CPU).
 * @param {any} state controller state
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function inspectCuda(state) {
  if (state.cudaCache && Date.now() - state.cudaCache.at < 60000) return state.cudaCache.value;
  let value;
  try {
    const probe = await runProcess('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeoutMs: 8000 });
    const gpu = lastLine(probe.stdout);
    value = probe.code === 0 && gpu ? { ok: true, detail: gpu } : { ok: false, detail: 'nvidia-smi sem GPU' };
  } catch {
    value = { ok: false, detail: 'nvidia-smi não encontrado (CPU será usada)' };
  }
  state.cudaCache = { at: Date.now(), value };
  return value;
}

// ── worker process ─────────────────────────────────────────────────────────

/** Persistent faster-whisper worker speaking JSON Lines over stdio. */
class WhisperWorker {
  /**
   * @param {{python: string, onLog: (text: string) => void, logPath: string}} options
   */
  constructor(options) {
    this.python = options.python;
    this.onLog = options.onLog;
    this.logPath = options.logPath;
    this.child = null;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.dead = true;
    this.lastStderr = '';
    this.lastProgress = null;
    this.progressListener = null;
    this.status = null;
  }

  /**
   * Spawn the worker and wait for its `status` handshake.
   * @param {any} state controller state
   * @param {ReturnType<typeof normalizeConfig>} config
   * @returns {Promise<Record<string, any>>} worker status
   */
  async start(state, config) {
    if (this.child && !this.dead) return this.status;
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
      STT_MODEL: config.model,
      STT_MODELS_DIR: paths().models,
      STT_DEVICE: config.device,
      STT_COMPUTE_TYPE: 'auto',
      STT_BEAM_SIZE: '5',
      STT_IDLE_SECONDS: String(Math.max(60, Math.round(config.idleShutdownMinutes * 60))),
      HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
      HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    };
    // pip CUDA wheels keep cublas64_12.dll/cudnn DLLs outside the DLL search
    // path; LoadLibrary only falls back to PATH, so contribute those dirs.
    const dllDirs = cudaLibraryDirs();
    if (dllDirs.length > 0) env.PATH = [...dllDirs, env.PATH ?? ''].join(delimiter);
    const child = spawn(this.python, [WORKER_SCRIPT], {
      cwd: paths().home,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.dead = false;
    this.buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this.onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      const last = lastLine(chunk);
      if (last) this.lastStderr = truncate(last, 240);
      this.onLog(chunk);
    });
    child.on('error', (error) => this.onExit(internalError(`worker Python falhou: ${error.message}`)));
    child.on('close', (code, signal) => {
      this.onExit(internalError(`worker Python encerrou (código ${String(code)}${signal ? `, sinal ${signal}` : ''})`));
    });
    this.onLog(`[host] worker iniciado pid=${child.pid} python=${this.python}\n`);
    try {
      this.status = await this.request('status', {}, 30000);
    } catch (error) {
      await this.stop();
      throw internalError(
        `Runtime de transcrição indisponível: ${error.message}. Verifique se o venv foi preparado (execute "Preparar" nas configurações).`,
      );
    }
    this.onLog(`[host] worker status: ${JSON.stringify(this.status)}\n`);
    return this.status;
  }

  /**
   * Send one command and await its JSON response.
   * @param {string} cmd protocol command
   * @param {Record<string, unknown>} payload command payload
   * @param {number} timeoutMs 0 disables the deadline (used by prepare)
   * @returns {Promise<any>} response result
   */
  request(cmd, payload, timeoutMs) {
    if (!this.child || this.dead) return Promise.reject(internalError('worker de transcrição não está em execução'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(internalError(`tempo esgotado ao executar ${cmd} (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, timer, cmd });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(internalError(`não foi possível enviar ${cmd} ao worker: ${error.message}`));
      }
    });
  }

  /** Accumulate stdout and dispatch complete JSON lines. */
  onStdout(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== '') this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  /** Handle one worker protocol line (response, progress event, or noise). */
  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onLog(`[worker:unparsed] ${truncate(line, 400)}\n`);
      return;
    }
    if (isRecord(message) && message.event === 'progress') {
      this.lastProgress = message;
      if (typeof this.progressListener === 'function') {
        try {
          this.progressListener(message);
        } catch {
          /* progress must never break the protocol */
        }
      }
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) {
      if (isRecord(message) && message.event) this.onLog(`[worker:event] ${truncate(line, 400)}\n`);
      return;
    }
    this.pending.delete(pending.id ?? message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else {
      const errorMessage = typeof message.error?.message === 'string' ? message.error.message : 'falha no worker de transcrição';
      pending.reject(message.error?.code === 'bad-request' ? badRequest(errorMessage) : internalError(errorMessage));
    }
  }

  /** Reject every in-flight request when the process is gone. */
  onExit(error) {
    this.dead = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onLog(`[host] worker encerrado: ${error.message}\n`);
  }

  /**
   * Stop the worker: polite `shutdown`, then termination after a short grace.
   * @param {{graceMs?: number}} [options]
   * @returns {Promise<void>}
   */
  async stop(options = {}) {
    const child = this.child;
    this.child = null;
    this.dead = true;
    if (!child) return;
    const exited = new Promise((resolve) => child.once('close', () => resolve(undefined)));
    try {
      child.stdin.write(`${JSON.stringify({ id: 0, cmd: 'shutdown' })}\n`);
    } catch {
      /* stdin already closed */
    }
    const killTimer = setTimeout(() => terminate(child), options.graceMs ?? 1500);
    killTimer.unref?.();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
    clearTimeout(killTimer);
    this.onLog('[host] worker parado\n');
  }

  /** Close stdin so the worker's idle loop ends; used by dispose. */
  dispose() {
    const child = this.child;
    this.child = null;
    this.dead = true;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ id: 0, cmd: 'shutdown' })}\n`);
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => terminate(child), 1200);
    timer.unref?.();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(internalError('plugin descarregado'));
    }
    this.pending.clear();
  }
}

// ── controller ──────────────────────────────────────────────────────────────

/**
 * Build the per-apply runtime controller: config, caches, worker lifecycle,
 * prepare state machine and the endpoint implementations.
 *
 * @param {any} ctx plugin context (only used for logging)
 */
function createController(ctx) {
  const state = {
    config: null,
    configWrite: Promise.resolve(),
    fwCache: null,
    cudaCache: null,
    statusCache: null,
    worker: null,
    prepare: {
      phase: 'idle',
      progress: 0,
      message: '',
      error: null,
      model: null,
      startedAt: 0,
      finishedAt: 0,
      steps: [],
    },
    prepareTask: null,
    prepareChild: null,
    cancelRequested: false,
    idleTimer: null,
    setupLogStream: null,
    disposed: false,
  };

  /** Append text to the prepare/setup log (best effort, never throws). */
  const appendSetupLog = (text) => {
    if (!text) return;
    appendFile(paths().setupLog, text).catch(() => undefined);
  };

  /** Append worker stderr/diagnostics to the worker log. */
  const appendWorkerLog = (text) => {
    if (!text) return;
    appendFile(paths().workerLog, text).catch(() => undefined);
  };

  /** Reset the idle timer; when it fires, unload the model to free VRAM/RAM. */
  const touchIdle = async () => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    const config = await readConfig();
    const minutes = Math.max(1, config.idleShutdownMinutes);
    state.idleTimer = setTimeout(() => {
      const worker = state.worker;
      state.worker = null;
      if (worker) {
        console.log('[voice-stt]', 'encerrando worker ocioso');
        void worker.stop();
      }
    }, minutes * 60000);
    state.idleTimer.unref?.();
  };

  /** @returns {Promise<ReturnType<typeof normalizeConfig>>} */
  async function readConfig() {
    if (state.config) return state.config;
    let raw = {};
    try {
      raw = JSON.parse(await readFile(paths().configFile, 'utf8'));
    } catch {
      raw = {};
    }
    state.config = normalizeConfig(raw);
    return state.config;
  }

  /** Persist the config atomically (temp file + rename), serialized. */
  async function writeConfig(config) {
    const { home, configFile } = paths();
    await mkdir(home, { recursive: true });
    const temp = `${configFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(temp, configFile);
  }

  /** Ensure the config file exists (so users can inspect/edit it). */
  async function ensureConfigFile() {
    await ensureDirs();
    if (!existsSync(paths().configFile)) await writeConfig(await readConfig());
  }

  /**
   * Spawn (or reuse) the worker.
   * @param {ReturnType<typeof normalizeConfig>} config
   */
  async function ensureWorker(config) {
    const python = venvPython();
    if (!existsSync(python)) {
      throw internalError(
        'Runtime de transcrição não instalado. Abra Configurações → Voz (ditado) e clique em "Preparar" para criar o venv e baixar o modelo.',
      );
    }
    if (state.worker && !state.worker.dead) return state.worker;
    const worker = new WhisperWorker({ python, logPath: paths().workerLog, onLog: appendWorkerLog });
    state.worker = worker;
    try {
      await worker.start(state, config);
    } catch (error) {
      if (state.worker === worker) state.worker = null;
      await worker.stop();
      throw error;
    }
    return worker;
  }

  /** Detach and stop the worker (used by cancel/dispose/config changes). */
  async function dropWorker(reason) {
    const worker = state.worker;
    state.worker = null;
    if (!worker) return;
    appendWorkerLog(`[host] dropping worker: ${reason}\n`);
    await worker.stop();
  }

  /**
   * Run the idempotent preparation pipeline. Resolves when ready; the RPC
   * `prepare` call returns immediately and the client polls `prepareStatus`.
   * @param {string} model validated model id
   */
  async function runPrepare(model) {
    const config = await readConfig();
    const prepare = state.prepare;
    const throwIfCancelled = () => {
      if (state.cancelRequested || state.disposed) throw internalError('preparação cancelada');
    };
    /** Advance the visible phase/progress. */
    const phase = (name, progress, message) => {
      prepare.phase = name;
      prepare.progress = Math.min(1, Math.max(0, progress));
      if (message) prepare.message = message;
    };
    try {
      await ensureConfigFile();
      phase('venv', 0.02, 'Verificando Python e venv…');
      if (!existsSync(venvPython())) {
        const python = await detectPython(config, { fresh: true });
        const label = `${python.version} (${python.source})`;
        prepare.steps.push({ id: 'python', state: 'ok', detail: label });
        appendSetupLog(`[prepare] usando Python ${label} em ${python.executable}\n`);
        phase('venv', 0.06, `Criando venv com Python ${python.version}…`);
        const args = [...python.args, '-m', 'venv', paths().venv];
        const result = await runSetupProcess(state, python.command, args, { timeoutMs: 300000, label: 'venv' });
        throwIfCancelled();
        if (result.code !== 0) throw internalError(`falha ao criar o venv: ${truncate(result.tail || 'erro desconhecido', 240)}`);
      } else {
        prepare.steps.push({ id: 'python', state: 'ok', detail: 'venv existente' });
      }
      throwIfCancelled();
      phase('pip', 0.2, 'Verificando faster-whisper…');
      let fw = await inspectFasterWhisper(state, { fresh: true });
      if (!fw.ok) {
        phase('pip', 0.24, 'Instalando faster-whisper (pip)…');
        appendSetupLog('[prepare] installing requirements\n');
        const result = await runSetupProcess(state, venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', REQUIREMENTS_FILE], {
          timeoutMs: 1800000,
          label: 'pip',
        });
        throwIfCancelled();
        if (result.code !== 0) throw internalError(`pip install falhou: ${truncate(result.tail || 'erro desconhecido', 240)}`);
        fw = await inspectFasterWhisper(state, { fresh: true });
        if (!fw.ok) throw internalError(`faster-whisper não importa após o pip: ${fw.detail}`);
      }
      prepare.steps.push({ id: 'pip', state: 'ok', detail: fw.detail });
      throwIfCancelled();
      // Optional GPU support: ctranslate2 on Windows needs cuBLAS DLLs that the
      // faster-whisper wheel does not bundle. Without them the worker is still
      // fully functional on CPU, so failures here are non-fatal.
      const cudaVisible = (await inspectCuda(state)).ok;
      if (config.cudaLibs === 'off' || config.device === 'cpu') {
        prepare.steps.push({ id: 'cuda-libs', state: 'skipped', detail: 'desativado (config)' });
      } else if (!cudaVisible) {
        prepare.steps.push({ id: 'cuda-libs', state: 'skipped', detail: 'GPU NVIDIA não detectada — usando CPU' });
      } else if (cudaLibsInstalled()) {
        prepare.steps.push({ id: 'cuda-libs', state: 'ok', detail: 'cuBLAS já instalado no venv' });
      } else {
        phase('cuda-libs', 0.55, 'Instalando cuBLAS para GPU (pip)…');
        try {
          const result = await runSetupProcess(
            state,
            venvPython(),
            ['-m', 'pip', 'install', '--disable-pip-version-check', CUDA_LIBS_PACKAGE],
            { timeoutMs: 1800000, label: 'cuda-libs' },
          );
          throwIfCancelled();
          if (result.code !== 0 || !cudaLibsInstalled()) {
            prepare.steps.push({
              id: 'cuda-libs',
              state: 'skipped',
              detail: `instalação indisponível (${truncate(result.tail || 'erro', 160)}); CPU será usada`,
            });
          } else {
            prepare.steps.push({ id: 'cuda-libs', state: 'ok', detail: `${CUDA_LIBS_PACKAGE} instalado` });
            invalidateCaches(state);
          }
        } catch (error) {
          if (state.cancelRequested) throw error;
          prepare.steps.push({ id: 'cuda-libs', state: 'skipped', detail: `${truncate(error.message, 160)}; CPU será usada` });
          appendSetupLog(`[prepare] cuda-libs skipped: ${String(error?.message ?? error)}\n`);
        }
      }
      throwIfCancelled();
      phase('model', 0.62, `Preparando modelo ${model}…`);
      const worker = await ensureWorker(config);
      // Surface worker progress (download/load) while the command is running.
      let lastBytes = 0;
      const ticker = setInterval(() => {
        if (state.disposed || state.cancelRequested) return;
        if (prepare.phase === 'model') {
          prepare.progress = Math.min(0.88, prepare.progress + 0.004);
          void inspectModel(model)
            .then((info) => {
              if (info.bytes > lastBytes) lastBytes = info.bytes;
              if (prepare.phase === 'model' && lastBytes > 0) {
                prepare.message = `Baixando modelo ${model}: ${(lastBytes / (1024 * 1024)).toFixed(1)} MB`;
              }
            })
            .catch(() => undefined);
        } else if (prepare.phase === 'load') {
          prepare.progress = Math.min(0.98, prepare.progress + 0.002);
        }
        if (worker.lastProgress?.message) prepare.message = worker.lastProgress.message;
        else if (worker.lastStderr && !/^(warnings\.warn|Warning:|To support|  warnings)/.test(worker.lastStderr)) {
          prepare.message = worker.lastStderr;
        }
      }, 1000);
      ticker.unref?.();
      worker.progressListener = (event) => {
        if (event.phase === 'model') phase('model', Math.max(prepare.progress, 0.62), event.message);
        else if (event.phase === 'load') phase('load', Math.max(prepare.progress, 0.9), event.message);
      };
      let loaded;
      try {
        loaded = await worker.request('prepare', { model, device: config.device, compute_type: 'auto' }, 0);
      } finally {
        clearInterval(ticker);
        worker.progressListener = null;
      }
      throwIfCancelled();
      state.statusCache = null;
      state.fwCache = null;
      if (worker.status) {
        worker.status.loaded = true;
        worker.status.model = loaded.model ?? model;
        worker.status.device = loaded.device ?? null;
        worker.status.computeType = loaded.computeType ?? null;
      }
      prepare.steps.push({ id: 'model', state: 'ok', detail: `${loaded.model} em ${String(loaded.device).toUpperCase()} (${loaded.computeType})` });
      phase('load', 0.97, 'Modelo carregado');
      phase('ready', 1, `Pronto — ${loaded.model} em ${String(loaded.device).toUpperCase()} (${loaded.computeType})`);
      prepare.finishedAt = Date.now();
      prepare.error = null;
      state.config = { ...config, model };
      await writeConfig(state.config);
      await touchIdle();
      console.log('[voice-stt]', `runtime pronto: modelo=${loaded.model} device=${loaded.device} compute=${loaded.computeType}`);
    } catch (error) {
      const cancelled = state.cancelRequested || /cancelada/.test(String(error?.message ?? ''));
      prepare.phase = cancelled ? 'idle' : 'error';
      prepare.progress = cancelled ? 0 : prepare.progress;
      prepare.message = cancelled ? 'Cancelado' : 'Falha na preparação';
      prepare.error = cancelled ? null : String(error?.message ?? error);
      prepare.finishedAt = Date.now();
      appendSetupLog(`[prepare] ${cancelled ? 'cancelled' : 'failed'}: ${String(error?.message ?? error)}\n`);
      if (!cancelled) console.error('[voice-stt]', 'falha na preparação:', error?.message ?? error);
    } finally {
      state.prepareChild = null;
    }
  }

  /**
   * Spawn one preparation child process, streaming its output into the setup
   * log and the visible phase message; cancellable via `state.prepareChild`.
   * @returns {Promise<{code: number|null, tail: string}>}
   */
  function runSetupProcess(controllerState, command, args, options) {
    return new Promise((resolve, reject) => {
      const prepare = controllerState.prepare;
      let child;
      try {
        child = spawn(command, args, {
          cwd: paths().home,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(internalError(`não foi possível executar ${command}: ${error.message}`));
        return;
      }
      controllerState.prepareChild = child;
      let settled = false;
      let tail = '';
      let lineBuffer = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminate(child);
        reject(internalError(`${options.label} excedeu ${Math.round(options.timeoutMs / 1000)}s`));
      }, options.timeoutMs);
      timer.unref?.();
      const onData = (chunk) => {
        const text = String(chunk);
        appendSetupLog(text);
        lineBuffer += text;
        let index = lineBuffer.indexOf('\n');
        while (index >= 0) {
          const line = lineBuffer.slice(0, index).trim();
          lineBuffer = lineBuffer.slice(index + 1);
          if (line !== '') {
            tail = truncate(line, 240);
            prepare.message = `${options.label}: ${tail}`;
            if (prepare.phase === 'pip') prepare.progress = Math.min(0.6, prepare.progress + 0.004);
            else if (prepare.phase === 'venv') prepare.progress = Math.min(0.2, prepare.progress + 0.01);
          }
          index = lineBuffer.indexOf('\n');
        }
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controllerState.prepareChild = null;
        reject(internalError(`falha ao executar ${command}: ${error.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controllerState.prepareChild = null;
        if (lineBuffer.trim() !== '') tail = truncate(lineBuffer.trim(), 240);
        resolve({ code, tail });
      });
    });
  }

  /** Public prepare state snapshot for `prepareStatus`/`prepare`. */
  function prepareSnapshot() {
    const prepare = state.prepare;
    return {
      phase: prepare.phase,
      running: prepare.phase !== 'idle' && prepare.phase !== 'ready' && prepare.phase !== 'error',
      progress: Math.round(prepare.progress * 100) / 100,
      message: prepare.message,
      error: prepare.error,
      model: prepare.model,
      steps: prepare.steps.slice(),
      startedAt: prepare.startedAt,
      elapsedMs: prepare.startedAt ? Date.now() - prepare.startedAt : 0,
    };
  }

  /** `status`: always answers, describing exactly what is missing. */
  async function status() {
    const config = await readConfig();
    const dir = paths();
    const checks = [];
    let pythonDetail = 'não detectado';
    let pythonOk = false;
    try {
      const python = await detectPython(config);
      pythonOk = true;
      pythonDetail = `${python.version} (${python.source}: ${python.executable})`;
    } catch (error) {
      pythonDetail = truncate(error.message, 400);
    }
    checks.push({ id: 'python', ok: pythonOk, detail: pythonDetail });
    const venvExists = existsSync(venvPython());
    checks.push({ id: 'venv', ok: venvExists, detail: venvExists ? dir.venv : 'venv ainda não criado (execute Preparar)' });
    const fw = await inspectFasterWhisper(state);
    checks.push({ id: 'faster-whisper', ok: fw.ok, detail: fw.detail });
    const modelInfo = await inspectModel(config.model);
    checks.push({
      id: 'model',
      ok: modelInfo.installed,
      detail: modelInfo.installed ? `${config.model} (${dir.models})` : `modelo ${config.model} não baixado (execute Preparar)`,
    });
    const cuda = await inspectCuda(state);
    const worker = state.worker && !state.worker.dead ? state.worker : null;
    // GPU "visible" only means the driver exposes a device; CUDA compute also
    // needs cuBLAS/cuDNN DLLs. Report what the worker actually loaded.
    const actualDevice = worker?.status?.device ?? null;
    let cudaCompute = 'unverified';
    if (!cuda.ok) cudaCompute = 'unavailable';
    else if (worker?.status?.loaded) cudaCompute = actualDevice === 'cuda' ? 'ok' : 'unavailable';
    const cuBLAS = cudaLibsInstalled();
    checks.push({
      id: 'cuda',
      ok: cuda.ok && cudaCompute !== 'unavailable',
      detail: cuda.ok
        ? `${cuda.detail} · compute CUDA: ${cudaCompute}${cuBLAS ? '' : ' · cuBLAS (pip) ausente — CPU'}`
        : cuda.detail,
    });
    const ready = pythonOk && venvExists && fw.ok && modelInfo.installed;
    const models = [];
    for (const entry of MODELS) {
      const info = entry === config.model ? modelInfo : await inspectModel(entry);
      models.push({ id: entry, installed: info.installed, bytes: info.bytes });
    }
    return {
      plugin: name,
      version: VERSION,
      ready,
      checks,
      models,
      config,
      runtime: {
        workerRunning: Boolean(worker),
        loaded: Boolean(worker && worker.status?.loaded),
        model: worker?.status?.model ?? null,
        device: worker?.status?.device ?? null,
        computeType: worker?.status?.computeType ?? null,
        cuda: {
          visible: cuda.ok,
          compute: cudaCompute,
          cuBLAS,
          detail: cuda.detail,
          driver: worker?.status?.cuda ?? null,
        },
        python: worker?.status?.python ?? null,
        fasterWhisper: fw.versions?.fasterWhisper ?? null,
      },
      prepare: prepareSnapshot(),
      limits: { maxAudioBytes: MAX_AUDIO_BYTES, maxAudioSeconds: config.maxAudioSeconds, maxAudioSecondsHard: MAX_AUDIO_SECONDS },
      paths: { home: dir.home, venv: dir.venv, models: dir.models, logs: dir.logs, config: dir.configFile, workerLog: dir.workerLog },
    };
  }

  /** `transcribe`: validate audio, run the worker, report text and latency. */
  async function transcribe(payload) {
    if (!isRecord(payload)) throw badRequest('payload inválido: esperado um objeto');
    const { audioBase64 } = payload;
    if (typeof audioBase64 !== 'string' || audioBase64.length === 0) throw badRequest('audioBase64 é obrigatório');
    if (audioBase64.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 16) {
      throw badRequest(`áudio excede o limite de ${MAX_AUDIO_BYTES} bytes (base64 ${audioBase64.length} caracteres)`);
    }
    const bytes = decodeBase64(audioBase64);
    if (bytes.length > MAX_AUDIO_BYTES) throw badRequest(`áudio excede o limite de ${MAX_AUDIO_BYTES} bytes`);
    const waveInfo = parseWave(bytes);
    const config = await readConfig();
    const maxSeconds = config.maxAudioSeconds;
    if (waveInfo.durationSeconds > maxSeconds + 0.05) {
      throw badRequest(`áudio de ${waveInfo.durationSeconds.toFixed(1)}s excede o limite configurado de ${maxSeconds}s`);
    }
    const language = normalizeLanguage(payload.language ?? config.language);
    const model = payload.model !== undefined ? requireModel(payload.model) : config.model;
    const worker = await ensureWorker(config);
    const timeoutMs = Math.min(240000, Math.max(45000, Math.round(waveInfo.durationSeconds * 4000)));
    let result;
    try {
      result = await worker.request(
        'transcribe',
        {
          wav_b64: audioBase64,
          language: language === 'auto' ? null : language,
          model,
          device: config.device,
          compute_type: 'auto',
        },
        timeoutMs,
      );
    } catch (error) {
      // A wedged worker (hung CUDA call, crashed process) must not poison every
      // later dictation: unload it so the next request starts a fresh process.
      if (error instanceof SttError && /tempo esgotado|encerrou|não está em execução|plugin descarregado/.test(error.message)) {
        await dropWorker(`transcrição interrompida: ${error.message}`);
      }
      if (error instanceof SttError) throw error;
      throw internalError(`falha na transcrição: ${error.message}`);
    } finally {
      void touchIdle();
    }
    if (worker.status) {
      worker.status.loaded = true;
      worker.status.model = result?.model ?? worker.status.model ?? model;
      worker.status.device = result?.device ?? worker.status.device ?? null;
      worker.status.computeType = result?.computeType ?? worker.status.computeType ?? null;
    }
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    console.log(
      '[voice-stt]',
      `transcrição: ${text.length} chars, áudio ${Number(result?.durationSeconds ?? waveInfo.durationSeconds).toFixed(2)}s, ` +
        `inferência ${result?.inferenceMs ?? '?'}ms, device=${result?.device ?? '?'}`,
    );
    return {
      text,
      language: typeof result?.language === 'string' ? result.language : language === 'auto' ? null : language,
      durationSeconds: Number(result?.durationSeconds ?? waveInfo.durationSeconds),
      inferenceMs: Number(result?.inferenceMs ?? 0),
      model: result?.model ?? model,
      device: result?.device ?? null,
      computeType: result?.computeType ?? null,
    };
  }

  /** `prepare`: start the pipeline (idempotent) and return the snapshot. */
  async function prepare(payload) {
    if (payload !== undefined && payload !== null && !isRecord(payload)) throw badRequest('payload inválido: esperado um objeto');
    const config = await readConfig();
    const requested = requireModel(payload?.model ?? config.model);
    if (prepareSnapshot().running) return { ...prepareSnapshot(), started: false };
    state.cancelRequested = false;
    state.prepare = {
      phase: 'venv',
      progress: 0.01,
      message: 'Iniciando preparação…',
      error: null,
      model: requested,
      startedAt: Date.now(),
      finishedAt: 0,
      steps: [],
    };
    console.log('[voice-stt]', `preparação iniciada (modelo=${requested})`);
    state.prepareTask = runPrepare(requested);
    return { ...prepareSnapshot(), started: true };
  }

  /** `cancel`: abort preparation and stop the worker (also cancels a dictation). */
  async function cancel() {
    state.cancelRequested = true;
    const child = state.prepareChild;
    if (child) terminate(child);
    state.prepareChild = null;
    state.prepare.phase = state.prepare.phase === 'error' ? 'error' : 'idle';
    state.prepare.message = 'Cancelado';
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    await dropWorker('prepare cancelado');
    console.log('[voice-stt]', 'preparação/worker cancelados');
    return { cancelled: true, prepare: prepareSnapshot() };
  }

  /** `setConfig`: validate + persist; restart the worker if runtime identity changed. */
  async function setConfig(payload) {
    const patch = validateConfigPatch(payload);
    const current = await readConfig();
    const next = { ...current, ...patch };
    await ensureDirs();
    state.config = next;
    state.configWrite = state.configWrite.then(() => writeConfig(next)).catch(() => undefined);
    await state.configWrite;
    const identityChanged =
      (patch.model !== undefined && patch.model !== current.model) ||
      (patch.device !== undefined && patch.device !== current.device) ||
      patch.pythonPath !== undefined;
    if (identityChanged) {
      invalidateCaches(state);
      await dropWorker('configuração alterada');
    }
    await touchIdle();
    console.log('[voice-stt]', `configuração atualizada: ${JSON.stringify(patch)}`);
    return { config: next, restartedWorker: identityChanged, prepare: prepareSnapshot() };
  }

  /** Dispatch one RPC endpoint with proto-pollution-safe lookup. */
  const endpoints = Object.freeze({
    status: () => status(),
    prepare: (payload) => prepare(payload),
    prepareStatus: () => prepareSnapshot(),
    transcribe: (payload) => transcribe(payload),
    cancel: () => cancel(),
    setConfig: (payload) => setConfig(payload),
  });

  return {
    state,
    async handle(endpoint, payload) {
      try {
        if (typeof endpoint !== 'string' || !Object.prototype.hasOwnProperty.call(endpoints, endpoint)) {
          throw badRequest(`endpoint desconhecido: ${String(endpoint)}`);
        }
        return await endpoints[endpoint](payload);
      } catch (error) {
        if (!(error instanceof SttError)) console.error('[voice-stt]', 'erro interno em', endpoint, error);
        throw error;
      }
    },
    readConfig,
    dispose() {
      state.disposed = true;
      state.cancelRequested = true;
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = null;
      if (state.prepareChild) terminate(state.prepareChild);
      state.prepareChild = null;
      const worker = state.worker;
      state.worker = null;
      if (worker) worker.dispose();
      void ctx;
    },
  };
}

// ── plugin body ─────────────────────────────────────────────────────────────

/**
 * Mount the plugin: register the `/voice-stt` RPC channel and wire the runtime.
 *
 * @param {any} ctx Cordis context with `connection` and `webServer` services
 * @returns {() => void} disposer that stops workers and clears timers
 */
export function apply(ctx) {
  const controller = createController(ctx);
  const rpcHandler = async (endpoint, payload) => {
    try {
      const value = await controller.handle(endpoint, payload);
      return ok(value);
    } catch (error) {
      return fail(error);
    }
  };
  const disposeRpc = registerRpcChannel(ctx, RPC_CHANNEL, rpcHandler);
  console.log('[voice-stt]', `plugin v${VERSION} ativo — canal ${RPC_CHANNEL} (home: ${sttHome()})`);
  return () => {
    try {
      if (typeof disposeRpc === 'function') disposeRpc();
    } catch {
      /* ignore unregister failures */
    }
    controller.dispose();
    console.log('[voice-stt]', 'plugin descarregado');
  };
}
