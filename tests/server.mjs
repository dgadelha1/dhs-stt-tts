#!/usr/bin/env node
/**
 * tests/server.mjs — testes das metades SERVIDOR (RPC Cordis) dos plugins.
 *
 * Importa `lib/index.js` de cada plugin com um ctx falso que captura
 * `connection.rpc.handle(channel, handler)`, chama `apply(ctx)` e exercita os
 * endpoints por RPC:
 *
 *   - envelope: { ok:true, value } | { ok:false, error:{ code, message } };
 *   - apenas códigos bad-request/internal (CONTRACT §3.3);
 *   - validações de entrada (texto vazio/grande, rate/pitch, WAV inválido,
 *     sample rate errado, oversize, duração máxima, modelo inválido);
 *   - endpoints desconhecidos e nomes perigosos (__proto__, constructor, ...);
 *   - proto-pollution: payload com __proto__/constructor não contamina
 *     Object.prototype e não passa por dispatch;
 *   - fallback de registro do canal quando `connection.rpc.handle` exige
 *     injeção de webServer (bug conhecido do 0.2.2-rc.1);
 *   - dispose encerra o canal e não deixa recursos ativos.
 *
 * Usa DSH_VOICE_HOME temporário: NUNCA toca o runtime real dos devs. Casos de
 * sucesso pesados (transcrição/síntese reais) ficam como skip aqui — são
 * cobertos pelo E2E com o runtime preparado.
 *
 * Uso:
 *   node tests/server.mjs [--strict] [--package dsh-whisper-stt] [--json-out <path>]
 *
 * Exit: 0 = sem falhas; 1 = alguma falha (ou skip em --strict).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServerCtx } from './lib/fake-ctx.mjs';
import {
  ARTIFACTS_DIR,
  PACKAGES_DIR,
  Reporter,
  ensureDir,
  fileExists,
  makeInvalidWavBase64,
  makeWav,
  makeWavBase64,
  matchKeywordGroups,
  readFixtureWavBase64,
  redactUrl,
} from './lib/util.mjs';

const ALLOWED_ERROR_CODES = new Set(['bad-request', 'internal']);
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
// SAPI (System.Speech/Add-Type) só existe no Windows; no CI linux esses casos SKIP.
const IS_WINDOWS = process.platform === 'win32';

const PLUGINS = {
  'dsh-whisper-stt': {
    channel: '/voice-stt',
    endpoints: ['status', 'prepare', 'prepareStatus', 'cancel', 'transcribe', 'setConfig'],
    heavySuccessNote:
      'transcrição real depende do venv/modelo; coberta pelo E2E (voice-dev com runtime preparado)',
  },
  'dsh-tts': {
    channel: '/voice-tts',
    endpoints: ['status', 'prepare', 'prepareStatus', 'synthesize', 'voices', 'cancel'],
    heavySuccessNote:
      'síntese real depende do edge-tts/rede ou SAPI; coberta pelo E2E (aceita engine edge ou sapi)',
  },
};

function parseArgs(argv) {
  const options = { strict: false, packages: [], jsonOut: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--package') options.packages.push(argv[(index += 1)]);
    else if (arg === '--json-out') options.jsonOut = argv[(index += 1)];
    else if (arg === '--help' || arg === '-h') {
      console.log('uso: node tests/server.mjs [--strict] [--package dsh-whisper-stt] [--json-out <path>]');
      process.exit(0);
    }
  }
  return options;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout de ${timeoutMs}ms em ${label}`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Valida o envelope RPC do contrato e devolve um resumo. */
function validateEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: `resposta não é objeto: ${JSON.stringify(raw)?.slice(0, 200)}` };
  }
  if (typeof raw.ok !== 'boolean') {
    return { valid: false, reason: `resposta sem ok booleano: ${JSON.stringify(raw)?.slice(0, 200)}` };
  }
  if (raw.ok === true) return { valid: true, ok: true, value: raw.value };
  const error = raw.error;
  if (!error || typeof error !== 'object') return { valid: false, reason: 'ok=false sem error' };
  if (typeof error.code !== 'string' || !ALLOWED_ERROR_CODES.has(error.code)) {
    return { valid: false, reason: `error.code inválido: ${JSON.stringify(error.code)} (permitido: bad-request, internal)` };
  }
  if (typeof error.message !== 'string' || !error.message.trim()) {
    return { valid: false, reason: 'error.message vazio' };
  }
  return { valid: true, ok: false, error };
}

class RpcClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async call(endpoint, payload, timeoutMs = 20000) {
    const started = Date.now();
    let outcome;
    try {
      const raw = await withTimeout(Promise.resolve(this.handler(endpoint, payload)), timeoutMs, `${endpoint}`);
      outcome = { raw, ms: Date.now() - started };
    } catch (error) {
      outcome = { thrown: error, ms: Date.now() - started };
    }
    this.calls.push({ endpoint, payload, outcome });
    return outcome;
  }
}

function persistPollutionCheck(reporter, prefix, label) {
  const polluted = Object.prototype.polluted;
  const polluted2 = Object.prototype.polluted2;
  if (polluted === undefined && polluted2 === undefined) {
    reporter.pass(`${prefix}:proto:${label}`, 'proto-pollution não contamina Object.prototype', 'ok');
  } else {
    reporter.fail(
      `${prefix}:proto:${label}`,
      'proto-pollution não contamina Object.prototype',
      `Object.prototype.polluted=${String(polluted)}, polluted2=${String(polluted2)}`,
    );
    delete Object.prototype.polluted;
    delete Object.prototype.polluted2;
  }
}

function resourceCounts() {
  const resources = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  const counts = {};
  for (const resource of resources) counts[resource] = (counts[resource] ?? 0) + 1;
  return counts;
}

async function expectBadRequest(reporter, client, prefix, id, endpoint, payload, label, timeoutMs = 20000) {
  const outcome = await client.call(endpoint, payload, timeoutMs);
  if (outcome.thrown) {
    reporter.fail(`${prefix}:${id}`, label, `handler lançou em vez de devolver envelope: ${outcome.thrown.message}`);
    return;
  }
  const envelope = validateEnvelope(outcome.raw);
  if (!envelope.valid) {
    reporter.fail(`${prefix}:${id}`, label, envelope.reason);
    return;
  }
  if (envelope.ok === false && envelope.error.code === 'bad-request') {
    reporter.pass(`${prefix}:${id}`, label, `bad-request: ${envelope.error.message.slice(0, 160)}`);
  } else if (envelope.ok === false) {
    reporter.fail(`${prefix}:${id}`, label, `esperado bad-request, recebido ${envelope.error.code}: ${envelope.error.message.slice(0, 160)}`);
  } else {
    reporter.fail(`${prefix}:${id}`, label, `esperado bad-request, recebido ok:true (${JSON.stringify(envelope.value).slice(0, 160)})`);
  }
}

function expectOkOrSkip(reporter, client, prefix, id, endpoint, payload, label, options = {}) {
  return client.call(endpoint, payload, options.timeoutMs ?? 20000).then((outcome) => {
    if (outcome.thrown) {
      reporter.fail(`${prefix}:${id}`, label, `handler lançou: ${outcome.thrown.message}`);
      return { outcome };
    }
    const envelope = validateEnvelope(outcome.raw);
    if (!envelope.valid) {
      reporter.fail(`${prefix}:${id}`, label, envelope.reason);
      return { outcome };
    }
    if (envelope.ok === true) {
      reporter.pass(`${prefix}:${id}`, label, `ok (${JSON.stringify(envelope.value).slice(0, 200)})`);
      return { outcome, value: envelope.value };
    }
    if (envelope.error.code === 'internal') {
      reporter.skip(
        `${prefix}:${id}`,
        label,
        `internal (dependência externa indisponível): ${envelope.error.message.slice(0, 220)}`,
      );
      return { outcome };
    }
    reporter.warn(
      `${prefix}:${id}`,
      label,
      `bad-request inesperado: ${envelope.error.message.slice(0, 220)}`,
    );
    return { outcome };
  });
}

async function testCallable(reporter, prefix, client, endpoint, label, payloads) {
  for (const entry of payloads) {
    const outcome = await client.call(endpoint, entry.payload, entry.timeoutMs ?? 20000);
    if (outcome.thrown) {
      reporter.fail(`${prefix}:${entry.id}`, label, `handler lançou: ${outcome.thrown.message}`);
      continue;
    }
    const envelope = validateEnvelope(outcome.raw);
    if (!envelope.valid) {
      reporter.fail(`${prefix}:${entry.id}`, label, envelope.reason);
    } else if (!entry.expect || entry.expect(envelope)) {
      reporter.pass(`${prefix}:${entry.id}`, label, `${envelope.ok ? 'ok' : envelope.error.code}`);
    } else {
      reporter.fail(`${prefix}:${entry.id}`, label, `esperado ${entry.expectDescription ?? 'bad-request'}, recebido ${envelope.ok ? 'ok' : envelope.error.code}`);
    }
  }
}

async function testChannelFallback(reporter, packageName, libIndex, config) {
  const prefix = packageName;
  const ctxBag = createServerCtx();
  const restore = ctxBag.simulateInjectBug();
  try {
    const moduleUrl = `${pathToFileURL(libIndex).href}?qa-fallback=${Date.now()}`;
    const module = await import(moduleUrl);
    await Promise.resolve(module.apply?.(ctxBag.ctx));
    restore();
    const handler = ctxBag.channels.get(config.channel);
    if (typeof handler === 'function') {
      reporter.pass(`${prefix}:channel-fallback`, 'canal registrado via connection.register (bug 0.2.2-rc.1)', config.channel);
    } else {
      reporter.fail(
        `${prefix}:channel-fallback`,
        'canal registrado via connection.register (bug 0.2.2-rc.1)',
        `canais registrados: [${[...ctxBag.channels.keys()].join(', ')}]`,
      );
    }
    ctxBag.disposeAll();
  } catch (error) {
    restore();
    reporter.fail(`${prefix}:channel-fallback`, 'canal registrado via connection.register (bug 0.2.2-rc.1)', error.stack ?? error.message);
  }
}

async function testPlugin(packageName, config, reporter, options) {
  const prefix = packageName;
  const libIndex = path.join(PACKAGES_DIR, packageName, 'lib', 'index.js');
  if (!fileExists(libIndex)) {
    reporter.skip(`${prefix}:load`, 'importar lib/index.js', `ausente: ${libIndex} (rode node scripts/sync.mjs)`);
    return;
  }

  // contexto isolado + apply
  const bag = createServerCtx();
  // baseline de handles do processo de teste (antes de qualquer efeito do plugin)
  const baselineResources = resourceCounts();
  let module;
  try {
    module = await import(pathToFileURL(libIndex).href);
  } catch (error) {
    reporter.fail(`${prefix}:load`, 'importar lib/index.js', error.stack ?? error.message);
    return;
  }
  reporter.pass(`${prefix}:load`, 'importar lib/index.js', 'módulo ESM carregado');

  if (typeof module.name === 'string' && module.name.trim()) {
    reporter.pass(`${prefix}:module-name`, 'export name', module.name);
  } else {
    reporter.fail(`${prefix}:module-name`, 'export name', `name inválido: ${JSON.stringify(module.name)}`);
  }
  const inject = Array.isArray(module.inject) ? module.inject : [];
  if (inject.includes('webServer') && inject.includes('connection')) {
    reporter.pass(`${prefix}:module-inject`, 'export inject', `[${inject.join(', ')}]`);
  } else {
    reporter.fail(`${prefix}:module-inject`, 'export inject', `esperado webServer+connection, recebido [${inject.join(', ')}]`);
  }
  if (typeof module.apply !== 'function') {
    reporter.fail(`${prefix}:module-apply`, 'export apply', `tipo=${typeof module.apply}`);
    return;
  }

  let applyResult;
  try {
    applyResult = module.apply(bag.ctx);
    await Promise.resolve(applyResult);
    reporter.pass(`${prefix}:apply`, 'apply(fakeCtx) executa', `efeitos: ${bag.effects.length}`);
  } catch (error) {
    reporter.fail(`${prefix}:apply`, 'apply(fakeCtx) executa', error.stack ?? error.message);
    return;
  }

  const handler = bag.channels.get(config.channel);
  if (typeof handler === 'function') {
    reporter.pass(`${prefix}:channel`, 'canal RPC do contrato registrado', config.channel);
  } else {
    reporter.fail(
      `${prefix}:channel`,
      'canal RPC do contrato registrado',
      `esperado ${config.channel}; registrados: [${[...bag.channels.keys()].join(', ')}]`,
    );
    return;
  }
  for (const channel of bag.channels.keys()) {
    if (CHANNEL_PATTERN.test(channel) === false) {
      reporter.fail(`${prefix}:channel-pattern`, 'canais obedecem CHANNEL_PATTERN', channel);
    }
  }

  const client = new RpcClient(handler);

  // status
  const status = await expectOkOrSkip(reporter, client, prefix, 'status', 'status', {}, 'status responde sem runtime', { timeoutMs: 30000 });
  if (status?.value && typeof status.value === 'object') {
    const text = JSON.stringify(status.value);
    const readable = /(python|venv|model|runtime|cuda|engine|voice|check|ready|phase|stt|tts)/i.test(text);
    if (readable) reporter.pass(`${prefix}:status-shape`, 'status informa o runtime', `${text.slice(0, 260)}`);
    else reporter.warn(`${prefix}:status-shape`, 'status informa o runtime', `valor sem campos reconhecíveis: ${text.slice(0, 260)}`);
  }

  // endpoints desconhecidos / perigosos
  const dangerous = ['nope', '', '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString'];
  for (const endpoint of dangerous) {
    const outcome = await client.call(endpoint, {});
    if (outcome.thrown) {
      reporter.fail(`${prefix}:unknown:${endpoint || '(vazio)'}`, 'endpoint desconhecido → bad-request', `handler lançou: ${outcome.thrown.message}`);
      continue;
    }
    const envelope = validateEnvelope(outcome.raw);
    if (!envelope.valid) {
      reporter.fail(`${prefix}:unknown:${endpoint || '(vazio)'}`, 'endpoint desconhecido → bad-request', envelope.reason);
    } else if (envelope.ok === false && envelope.error.code === 'bad-request') {
      reporter.pass(`${prefix}:unknown:${endpoint || '(vazio)'}`, 'endpoint desconhecido → bad-request', `bad-request: ${envelope.error.message.slice(0, 120)}`);
    } else {
      reporter.fail(
        `${prefix}:unknown:${endpoint || '(vazio)'}`,
        'endpoint desconhecido → bad-request',
        `esperado bad-request, recebido ${envelope.ok ? 'ok:true' : envelope.error.code}`,
      );
    }
  }

  // proto-pollution no payload
  const pollutionPayload = JSON.parse(
    '{"text":"","lang":"pt-BR","audioBase64":"","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}}}',
  );
  const pollutionEndpoint = packageName === 'dsh-whisper-stt' ? 'transcribe' : 'synthesize';
  const pollution = await client.call(pollutionEndpoint, pollutionPayload);
  if (pollution.thrown) {
    reporter.fail(`${prefix}:proto:payload`, 'payload com __proto__ não contamina', `handler lançou: ${pollution.thrown.message}`);
  } else {
    const envelope = validateEnvelope(pollution.raw);
    if (envelope.valid) reporter.pass(`${prefix}:proto:payload`, 'payload com __proto__ é rejeitado/normalizado', `${envelope.ok ? 'ok' : envelope.error.code}`);
    else reporter.fail(`${prefix}:proto:payload`, 'payload com __proto__ é rejeitado/normalizado', envelope.reason);
  }
  persistPollutionCheck(reporter, prefix, 'payload');

  // casos específicos por plugin
  if (packageName === 'dsh-whisper-stt') {
    await expectBadRequest(reporter, client, prefix, 'transcribe-missing', 'transcribe', {}, 'transcribe sem audioBase64 → bad-request');
    await expectBadRequest(reporter, client, prefix, 'transcribe-notbase64', 'transcribe', { audioBase64: '!!!não é base64!!!' }, 'transcribe com base64 inválido → bad-request');
    await expectBadRequest(reporter, client, prefix, 'transcribe-garbage', 'transcribe', { audioBase64: makeInvalidWavBase64() }, 'transcribe com WAV corrompido → bad-request');
    await expectBadRequest(reporter, client, prefix, 'transcribe-rate', 'transcribe', { audioBase64: makeWav({ seconds: 1, sampleRate: 44100 }).toString('base64') }, 'transcribe com sample rate != 16 kHz → bad-request');
    await expectBadRequest(reporter, client, prefix, 'transcribe-oversize', 'transcribe', { audioBase64: makeWavBase64({ seconds: 1 }).slice(0, 4 * 1024 * 1024 + 1024) + 'A'.repeat(2048) }, 'transcribe com payload > 4 MB → bad-request', 30000);
    await expectBadRequest(reporter, client, prefix, 'transcribe-toolong', 'transcribe', { audioBase64: makeWavBase64({ seconds: 61 }) }, 'transcribe com 61 s (maxAudioSeconds default 60) → bad-request', 30000);
    await expectBadRequest(reporter, client, prefix, 'transcribe-lang', 'transcribe', { audioBase64: makeWavBase64({ seconds: 1 }), language: 'klingon' }, 'transcribe com language inválido → bad-request');
    await expectBadRequest(reporter, client, prefix, 'prepare-model', 'prepare', { model: '../../../etc/passwd' }, 'prepare com modelo fora da lista → bad-request');
    await testCallable(reporter, prefix, client, 'prepareStatus', 'prepareStatus devolve fase/progresso', [
      { id: 'prepareStatus', payload: {} },
    ]);
    await testCallable(reporter, prefix, client, 'cancel', 'cancel responde envelope', [{ id: 'cancel', payload: {} }]);
    // sucesso pesado fica como skip documentado
    const fixture = readFixtureWavBase64('pt-br.wav');
    const heavy = await client.call('transcribe', { audioBase64: fixture.base64, language: 'pt' }, 120000);
    if (heavy.thrown) {
      reporter.fail(`${prefix}:transcribe-valid`, 'transcribe de WAV fixture (sucesso real)', `handler lançou: ${heavy.thrown.message}`);
    } else {
      const envelope = validateEnvelope(heavy.raw);
      if (!envelope.valid) reporter.fail(`${prefix}:transcribe-valid`, 'transcribe de WAV fixture (sucesso real)', envelope.reason);
      else if (envelope.ok) {
        const text = envelope.value?.text;
        const match = matchKeywordGroups(text, [['teste'], ['ditado'], ['portugues', 'português'], ['dois', 'tres', 'três']], 2);
        if (match.ok) reporter.pass(`${prefix}:transcribe-valid`, 'transcribe de WAV fixture (sucesso real)', `texto="${String(text).slice(0, 160)}"`);
        else reporter.fail(`${prefix}:transcribe-valid`, 'transcribe de WAV fixture (sucesso real)', `texto sem palavras-chave: ${JSON.stringify(text)}`);
      } else {
        reporter.skip(`${prefix}:transcribe-valid`, 'transcribe de WAV fixture (sucesso real)', `${config.heavySuccessNote}: ${envelope.error.message.slice(0, 200)}`);
      }
    }
  }

  if (packageName === 'dsh-tts') {
    const longText = 'a'.repeat(4001);
    await expectBadRequest(reporter, client, prefix, 'synth-missing', 'synthesize', {}, 'synthesize sem texto → bad-request');
    await expectBadRequest(reporter, client, prefix, 'synth-empty', 'synthesize', { text: '', lang: 'pt-BR' }, 'synthesize com texto vazio → bad-request');
    await expectBadRequest(reporter, client, prefix, 'synth-whitespace', 'synthesize', { text: '   \n\t  ', lang: 'pt-BR' }, 'synthesize só com espaços → bad-request');
    await expectBadRequest(reporter, client, prefix, 'synth-long', 'synthesize', { text: longText, lang: 'pt-BR' }, 'synthesize com 4001 chars → bad-request');
    await expectBadRequest(reporter, client, prefix, 'synth-lang', 'synthesize', { text: 'teste', lang: 'xx-XX' }, 'synthesize com lang inválido → bad-request');
    await expectBadRequest(reporter, client, prefix, 'synth-rate-high', 'synthesize', { text: 'teste', lang: 'pt-BR', rate: 5 }, 'synthesize com rate 5 → bad-request');
    await expectBadRequest(reporter, client, prefix, 'synth-rate-low', 'synthesize', { text: 'teste', lang: 'pt-BR', rate: 0.1 }, 'synthesize com rate 0.1 → bad-request');
    await expectBadRequest(reporter, client, prefix, 'synth-pitch', 'synthesize', { text: 'teste', lang: 'pt-BR', pitch: 99 }, 'synthesize com pitch 99 → bad-request');
    await expectBadRequest(reporter, client, prefix, 'synth-engine', 'synthesize', { text: 'teste', lang: 'pt-BR', engine: 'quantum' }, 'synthesize com engine inválido → bad-request');
    await testCallable(reporter, prefix, client, 'prepareStatus', 'prepareStatus devolve fase/progresso', [{ id: 'prepareStatus', payload: {} }]);
    await testCallable(reporter, prefix, client, 'cancel', 'cancel responde envelope', [{ id: 'cancel', payload: {} }]);
    // Integração SAPI via PowerShell é Windows-only: no CI linux (e quando não há
    // voz instalada) vira SKIP, nunca FAIL.
    if (!IS_WINDOWS) {
      reporter.skip(
        `${prefix}:sapi`,
        'synthesize SAPI offline (Windows-only)',
        `plataforma ${process.platform}: System.Speech não existe; coberto nos runners Windows/ambiente local`,
      );
    }
    else {
      const sapiOutcome = await client.call('synthesize', { text: 'Teste de voz offline.', lang: 'pt-BR', engine: 'sapi' }, 90000);
      if (sapiOutcome.thrown) {
        reporter.fail(`${prefix}:sapi`, 'synthesize SAPI offline', `handler lançou: ${sapiOutcome.thrown.message}`);
      }
      else {
        const sapiEnvelope = validateEnvelope(sapiOutcome.raw);
        if (!sapiEnvelope.valid) {
          reporter.fail(`${prefix}:sapi`, 'synthesize SAPI offline', sapiEnvelope.reason);
        }
        else if (sapiEnvelope.ok) {
          const value = sapiEnvelope.value ?? {};
          const bytes = Buffer.from(String(value.audioBase64 ?? ''), 'base64').length;
          const ok = value.engine === 'sapi' && typeof value.mime === 'string' && value.mime.startsWith('audio/') && bytes > 1024;
          if (ok) reporter.pass(`${prefix}:sapi`, 'synthesize SAPI offline', `${bytes} bytes, mime=${value.mime}, voice=${value.voice}`);
          else reporter.fail(`${prefix}:sapi`, 'synthesize SAPI offline', `resposta inválida: ${JSON.stringify({ bytes, mime: value.mime, engine: value.engine })}`);
        }
        else if (/voz|voice|sapi|System\.Speech|Add-Type|nao encontrad|não encontrad/i.test(sapiEnvelope.error.message)) {
          // Windows sem voz SAPI instalada (ex.: runner minimal): SKIP, não FAIL.
          reporter.skip(`${prefix}:sapi`, 'synthesize SAPI offline', `sem voz SAPI disponível: ${sapiEnvelope.error.message.slice(0, 220)}`);
        }
        else {
          reporter.fail(`${prefix}:sapi`, 'synthesize SAPI offline', `${sapiEnvelope.error.code}: ${sapiEnvelope.error.message.slice(0, 220)}`);
        }
      }
    }
    for (const [id, lang, text] of [
      ['synth-valid-pt', 'pt-BR', 'Olá! Este é um teste de leitura em voz alta.'],
      ['synth-valid-en', 'en-US', 'Hello! This is a text to speech test.'],
    ]) {
      const outcome = await client.call('synthesize', { text, lang }, 90000);
      if (outcome.thrown) {
        reporter.fail(`${prefix}:${id}`, `synthesize real ${lang}`, `handler lançou: ${outcome.thrown.message}`);
        continue;
      }
      const envelope = validateEnvelope(outcome.raw);
      if (!envelope.valid) {
        reporter.fail(`${prefix}:${id}`, `synthesize real ${lang}`, envelope.reason);
      } else if (envelope.ok) {
        const value = envelope.value ?? {};
        const bytes = Buffer.from(String(value.audioBase64 ?? ''), 'base64').length;
        const mimeOk = typeof value.mime === 'string' && value.mime.startsWith('audio/');
        const engineOk = ['edge', 'sapi'].includes(value.engine);
        if (bytes > 1024 && mimeOk && engineOk) {
          reporter.pass(`${prefix}:${id}`, `synthesize real ${lang}`, `${bytes} bytes, mime=${value.mime}, engine=${value.engine}, voice=${value.voice}`);
        } else {
          reporter.fail(
            `${prefix}:${id}`,
            `synthesize real ${lang}`,
            `resposta inválida: bytes=${bytes}, mime=${JSON.stringify(value.mime)}, engine=${JSON.stringify(value.engine)}`,
          );
        }
      } else {
        reporter.skip(`${prefix}:${id}`, `synthesize real ${lang}`, `${config.heavySuccessNote}: ${envelope.error.message.slice(0, 220)}`);
      }
    }
  }

  // dispose
  try {
    if (typeof applyResult === 'function') applyResult();
    bag.disposeAll();
    if (bag.channels.size === 0) {
      reporter.pass(`${prefix}:dispose`, 'dispose encerra o canal RPC', 'canais: 0');
    } else {
      reporter.fail(`${prefix}:dispose`, 'dispose encerra o canal RPC', `canais restantes: [${[...bag.channels.keys()].join(', ')}]`);
    }
    // dá tempo para handles assíncronos (fs/child) se fecharem antes de amostrar
    await new Promise((resolve) => setTimeout(resolve, 500));
    const resources = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
    const current = {};
    for (const resource of resources) current[resource] = (current[resource] ?? 0) + 1;
    const leaked = Object.entries(current).filter(
      ([type, count]) => count > (baselineResources[type] ?? 0) && !/TTYWrap|PipeWrap/.test(type),
    );
    if (leaked.length === 0) {
      reporter.pass(`${prefix}:dispose-resources`, 'dispose não deixa recursos suspeitos', 'nenhum handle novo de processo/socket/timer');
    } else {
      reporter.warn(
        `${prefix}:dispose-resources`,
        'dispose não deixa recursos suspeitos',
        leaked.map(([type, count]) => `${type}+${count - (baselineResources[type] ?? 0)}`).join(', '),
      );
    }
  } catch (error) {
    reporter.fail(`${prefix}:dispose`, 'dispose', error.stack ?? error.message);
  }

  // registro com o bug do 0.2.2-rc.1 (connection.register fallback)
  await testChannelFallback(reporter, packageName, libIndex, config);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(ARTIFACTS_DIR);

  // Runtime isolado: nenhum teste toca o venv/modelo reais dos devs.
  const voiceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-qa-server-'));
  process.env.DSH_VOICE_HOME = voiceHome;

  const reporter = new Reporter('server', {
    jsonOut: options.jsonOut ?? path.join(ARTIFACTS_DIR, 'server-report.json'),
  });
  reporter.summaryExtra = { voiceHome };

  console.log(`server: DSH_VOICE_HOME isolado em ${voiceHome}`);
  const names = options.packages.length ? options.packages : Object.keys(PLUGINS);
  for (const name of names) {
    if (!PLUGINS[name]) {
      console.error(`server: pacote desconhecido (use ${Object.keys(PLUGINS).join(', ')})`);
      process.exit(2);
    }
    try {
      await testPlugin(name, PLUGINS[name], reporter, options);
    } catch (error) {
      reporter.fail(`${name}:unexpected`, 'erro inesperado no teste de servidor', error.stack ?? error.message);
    }
  }

  const ok = reporter.print({ strict: options.strict });
  reporter.write();
  // servidores podem segurar handles de worker; sai explicitamente para não pendurar o run-all
  try {
    fs.rmSync(voiceHome, { recursive: true, force: true });
  } catch {
    /* noop */
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('server: erro fatal:', error);
  process.exit(1);
});


