/**
 * Utilidades comuns do harness de QA do DSH Voice Suite.
 *
 * Sem dependências externas: Node >= 20. Usado por smoke-client.mjs,
 * server.mjs e e2e.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Raiz do repositório derivada do próprio módulo (portátil: Windows/Linux/macOS).
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const TESTS_DIR = path.join(ROOT, 'tests');
export const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures');
export const ARTIFACTS_DIR = path.join(TESTS_DIR, 'artifacts');
export const PACKAGES_DIR = path.join(ROOT, 'packages');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(`não consegui ler JSON ${file}: ${error.message}`);
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function readFileIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Normaliza texto para comparação tolerante: sem acentos, minúsculo, sem pontuação. */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Verifica grupos de sinônimos: exige `minGroups` (default: ceil(n*0.5)) grupos presentes. */
export function matchKeywordGroups(text, groups, minGroups) {
  const normalized = normalizeText(text);
  const required = Number.isFinite(minGroups) ? minGroups : Math.ceil((groups?.length ?? 0) * 0.5);
  const details = (groups ?? []).map((group) => {
    const alternatives = Array.isArray(group) ? group : [group];
    const hit = alternatives.find((word) => normalized.includes(normalizeText(word)));
    return { alternatives, hit: hit ?? null, ok: Boolean(hit) };
  });
  const matched = details.filter((entry) => entry.ok).length;
  return {
    ok: matched >= required,
    matched,
    required,
    total: details.length,
    normalized,
    details,
  };
}

/** Remove o token do URL para relatórios/logs. */
export function redactUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    for (const key of ['token', 'access_token', 'auth']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '***');
    }
    return parsed.toString();
  } catch {
    return String(url).replace(/([?&](?:token|access_token|auth)=)[^&#]+/gi, '$1***');
  }
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function tail(text, maxChars = 1200) {
  const value = String(text ?? '');
  return value.length <= maxChars ? value : `…${value.slice(value.length - maxChars)}`;
}

/** Lê o manifesto de fixtures (texts.json). */
export function loadFixtureManifest() {
  return readJson(path.join(FIXTURES_DIR, 'texts.json'));
}

/** Lê um WAV de fixture como base64 (para os payloads RPC). */
export function readFixtureWavBase64(relativeFile) {
  const file = path.join(FIXTURES_DIR, relativeFile);
  const buffer = fs.readFileSync(file);
  return { file, bytes: buffer.length, base64: buffer.toString('base64'), buffer };
}

/** Parse mínimo de WAV para validar/gerar fixtures e payloads de teste. */
export function parseWav(buffer) {
  const out = {
    ok: false,
    reason: '',
    sampleRate: 0,
    channels: 0,
    bitsPerSample: 0,
    formatTag: 0,
    dataBytes: 0,
    durationSeconds: 0,
    fileBytes: buffer?.length ?? 0,
  };
  if (!buffer || buffer.length < 44) {
    out.reason = 'arquivo pequeno demais';
    return out;
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    out.reason = 'cabeçalho RIFF/WAVE inválido';
    return out;
  }
  let pos = 12;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const payload = pos + 8;
    if (id === 'fmt ') {
      out.formatTag = buffer.readUInt16LE(payload);
      out.channels = buffer.readUInt16LE(payload + 2);
      out.sampleRate = buffer.readUInt32LE(payload + 4);
      out.bitsPerSample = buffer.readUInt16LE(payload + 14);
    } else if (id === 'data') {
      out.dataBytes = Math.min(size, buffer.length - payload);
    }
    const advance = 8 + size + (size % 2);
    if (advance <= 0) break;
    pos += advance;
  }
  out.ok =
    out.formatTag === 1 &&
    out.channels === 1 &&
    out.sampleRate === 16000 &&
    out.bitsPerSample === 16 &&
    out.dataBytes > 0;
  out.reason = out.ok
    ? `${out.sampleRate} Hz, ${out.channels} canal, ${out.bitsPerSample} bits, ${(out.dataBytes / (out.sampleRate * 2)).toFixed(2)}s`
    : 'formato diferente de 16 kHz mono PCM16';
  out.durationSeconds = out.sampleRate > 0 ? out.dataBytes / (out.sampleRate * out.channels * (out.bitsPerSample / 8)) : 0;
  return out;
}

/** Gera um WAV PCM16 válido (default 16 kHz mono), com fala fake (silêncio). */
export function makeWav({ seconds = 1, sampleRate = 16000, channels = 1, bits = 16, fill = 0 } = {}) {
  const bytesPerSample = bits / 8;
  const dataBytes = Math.max(1, Math.round(seconds * sampleRate * channels * bytesPerSample));
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  if (fill) buffer.fill(fill, 44);
  return buffer;
}

export function makeWavBase64(options) {
  return makeWav(options).toString('base64');
}

/** Buffer "quase base64" inválido / WAV corrompido para casos bad-request. */
export function makeInvalidWavBase64() {
  return Buffer.from('RIFFxxxxWAVEfmt not really a wave file at all').toString('base64');
}

/**
 * Coletor de casos de teste com saída legível, relatório JSON e exit code.
 */
export class Reporter {
  constructor(name, options = {}) {
    this.name = name;
    this.startedAt = new Date();
    this.cases = [];
    this.warnings = [];
    this.options = options;
    this.writeJsonOut = options.jsonOut ?? path.join(ARTIFACTS_DIR, `${name}-report.json`);
  }

  #record(status, id, name, detail, extra = {}) {
    const entry = {
      id,
      name,
      status,
      detail: detail ?? '',
      durationMs: extra.durationMs ?? 0,
      evidence: extra.evidence ?? null,
      at: new Date().toISOString(),
    };
    this.cases.push(entry);
    return entry;
  }

  pass(id, name, detail, extra) {
    return this.#record('pass', id, name, detail, extra);
  }

  fail(id, name, detail, extra) {
    return this.#record('fail', id, name, detail, extra);
  }

  skip(id, name, detail, extra) {
    return this.#record('skip', id, name, detail, extra);
  }

  warn(id, name, detail, extra) {
    const entry = this.#record('warn', id, name, detail, extra);
    this.warnings.push(entry);
    return entry;
  }

  get counts() {
    const counts = { pass: 0, fail: 0, skip: 0, warn: 0 };
    for (const entry of this.cases) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return counts;
  }

  get failures() {
    return this.cases.filter((entry) => entry.status === 'fail');
  }

  /**
   * Imprime o relatório em stdout.
   * @param {{strict?: boolean}} options strict: skips também contam como falha.
   */
  print(options = {}) {
    const symbols = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', warn: 'WARN' };
    console.log('');
    console.log(`=== ${this.name} ===`);
    for (const entry of this.cases) {
      const symbol = symbols[entry.status] ?? entry.status.toUpperCase();
      const duration = entry.durationMs ? ` (${fmtMs(entry.durationMs)})` : '';
      console.log(`[${symbol}] ${entry.id} — ${entry.name}${duration}`);
      if (entry.detail) {
        for (const line of String(entry.detail).split('\n')) console.log(`         ${line}`);
      }
    }
    const counts = this.counts;
    console.log('');
    console.log(
      `${this.name}: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip, ${counts.warn} warn`,
    );
    const strictSkips = Boolean(options.strict) && counts.skip > 0;
    if (counts.fail === 0 && !strictSkips) {
      console.log(`${this.name}: OK`);
    } else {
      console.log(`${this.name}: ${strictSkips ? 'SKIP em modo --strict' : 'FALHOU'}`);
    }
    return counts.fail === 0 && !strictSkips;
  }

  summary() {
    const counts = this.counts;
    return {
      suite: this.name,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt.getTime(),
      counts,
      ok: counts.fail === 0,
      cases: this.cases,
      warnings: this.warnings.map((entry) => ({ id: entry.id, detail: entry.detail })),
    };
  }

  write() {
    try {
      writeJson(this.writeJsonOut, this.summary());
      console.log(`${this.name}: relatório JSON em ${this.writeJsonOut}`);
    } catch (error) {
      console.error(`${this.name}: não consegui escrever o relatório: ${error.message}`);
    }
  }

  /** Fecha o relatório e encerra o processo com o código adequado. */
  finish(options = {}) {
    const ok = this.print(options);
    this.write();
    process.exitCode = ok ? 0 : 1;
    return ok;
  }
}

/** Encontra pacotes presentes no repo, com estado de src/lib. */
export function inspectPackages(names = ['dsh-whisper-stt', 'dsh-tts']) {
  return names.map((name) => {
    const dir = path.join(PACKAGES_DIR, name);
    return {
      name,
      dir,
      exists: fileExists(path.join(dir, 'package.json')),
      srcIndex: fileExists(path.join(dir, 'src', 'index.js')),
      srcClient: fileExists(path.join(dir, 'src', 'client.js')),
      libIndex: fileExists(path.join(dir, 'lib', 'index.js')),
      libClient: fileExists(path.join(dir, 'lib', 'client.js')),
      runtime: fileExists(path.join(dir, 'runtime', 'requirements.txt')),
    };
  });
}
