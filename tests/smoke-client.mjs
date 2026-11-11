#!/usr/bin/env node
/**
 * tests/smoke-client.mjs — smoke test das metades CLIENTE dos plugins, sem browser.
 *
 * Carrega `lib/client.js` num contexto `vm` com um stub de
 * `window.__ModuleLoader__.load`, injeta `react` real, chama `apply(fakeCtx)` e
 * verifica o contrato §3.4/§3.5/§6:
 *
 *   - id do loader = nome do pacote;
 *   - `exports.inject` exatamente o esperado;
 *   - slots registrados (nomes/ids) e efeitos com label;
 *   - dicionários i18n pt/en completos e `t()` funcionando;
 *   - CSS injetado via <style data-plugin="..."> só com tokens --dsw- (sem hex);
 *   - `window.__dshVoiceDebug.<stt|tts>.rpc` presente e roteando pelo canal certo;
 *   - cada componente renderiza via react-dom/server com props mínimas;
 *   - dispose remove o CSS e desregistra os slots sem lançar.
 *
 * Uso:
 *   node tests/smoke-client.mjs [--strict] [--package dsh-tts] [--json-out <path>]
 *
 * Exit: 0 = sem falhas; 1 = alguma falha (ou skip em --strict).
 */

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadClientBundle } from './lib/fake-dom.mjs';
import { createClientCtx } from './lib/fake-ctx.mjs';
import {
  ARTIFACTS_DIR, PACKAGES_DIR, Reporter, ensureDir, fileExists, readJson, redactUrl,
} from './lib/util.mjs';

const CONFIG = {
  'dsh-whisper-stt': {
    debugKey: 'stt',
    namespace: 'whisper-stt',
    channel: '/voice-stt',
    inject: ['slots', 'locale', 'connection', 'sessions'],
    slots: [
      { name: 'conversation.input.activity' },
      { name: 'settings.section', id: 'voice-stt' },
    ],
    renderExpect: {
      'conversation.input.activity': ['data-voice-stt-button'],
      'settings.section': ['data-voice-stt-settings'],
    },
    minDictKeys: 15,
    props: {
      'conversation.input.activity': { sessionId: 'qa-session', inputActions: makeInputActions() },
      'settings.section': {},
    },
  },
  'dsh-tts': {
    debugKey: 'tts',
    namespace: 'tts',
    channel: '/voice-tts',
    // CONTRACT §3.4 atualizado: core sem uiSession; uiSession é opcional (não falha).
    inject: ['slots', 'locale', 'connection', 'sessions'],
    optionalInject: ['uiSession'],
    slots: [
      // CONTRACT §3.5: conversation.input.left (kind list, scope session) é o slot do TTS.
      { name: 'conversation.input.left', order: 20 },
      { name: 'conversation.chat.assistant-actions' },
      { name: 'settings.section', id: 'voice-tts' },
    ],
    renderExpect: {
      'conversation.input.left': ['data-voice-tts-button'],
      'conversation.chat.assistant-actions': ['data-voice-tts-message-button'],
      'settings.section': ['data-voice-tts-settings'],
    },
    minDictKeys: 15,
    // Componente por mensagem sem sessão/mensagem conhecida pode renderizar null
    // de forma defensiva (CONTRACT §3.5/§3.6); vazio é aceitável aqui.
    allowEmptyRender: ['conversation.chat.assistant-actions'],
    props: {
      'conversation.input.left': { sessionId: 'qa-session', inputActions: makeInputActions() },
      'conversation.chat.assistant-actions': { sessionId: 'qa-session', messageId: 'qa-message-1' },
      'settings.section': {},
    },
  },
};

function makeInputActions() {
  return {
    captureInsertion: () => ({ draftRev: 1 }),
    insertText: () => true,
    setDraft: () => {},
    submit: () => {},
    insertQuote: () => {},
    addAttachments: () => {},
    removeAttachment: () => {},
  };
}

function parseArgs(argv) {
  const options = { strict: false, packages: [], jsonOut: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--package') options.packages.push(argv[(index += 1)]);
    else if (arg === '--json-out') options.jsonOut = argv[(index += 1)];
    else if (arg === '--help' || arg === '-h') {
      console.log('uso: node tests/smoke-client.mjs [--strict] [--package dsh-tts] [--json-out <path>]');
      process.exit(0);
    }
  }
  return options;
}

function sameSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function countDictKeys(dict) {
  return dict && typeof dict === 'object' ? Object.keys(dict).length : 0;
}

function detectHardcodedColors(css) {
  const matches = [];
  // procura hex de 6/8 dígitos em contexto de valor CSS (evita #id de seletor)
  const regex = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g;
  let match;
  while ((match = regex.exec(css))) {
    const before = css.slice(Math.max(0, match.index - 30), match.index);
    if (/url\([^)]*$/.test(before)) continue; // url(#gradient) não é cor
    matches.push(match[0]);
  }
  return matches;
}

async function testPlugin(packageName, config, reporter, options) {
  const dir = path.join(PACKAGES_DIR, packageName);
  const clientFile = path.join(dir, 'lib', 'client.js');
  const prefix = packageName;

  if (!fileExists(clientFile)) {
    reporter.skip(
      `${prefix}:load`,
      'carregar lib/client.js',
      `ausente: ${clientFile} (o dev ainda não gerou/sincronizou lib/; rode node scripts/sync.mjs)`,
    );
    return;
  }

  // 1) carregar bundle no vm
  let bundle;
  try {
    bundle = await loadClientBundle({
      filePath: clientFile,
      filename: clientFile,
      deps: { react: React },
    });
    reporter.pass(`${prefix}:load`, 'carregar lib/client.js no __ModuleLoader__ stub', 'módulo avaliado no vm sem erro');  } catch (error) {
    reporter.fail(`${prefix}:load`, 'carregar lib/client.js no __ModuleLoader__ stub', error.stack ?? error.message);
    return;
  }

  const { entry, exports } = bundle;
  const debug = { packageName, entry: { id: entry.id }, clientFile };
  if (entry.id === packageName) {
    reporter.pass(`${prefix}:loader-id`, 'id do __ModuleLoader__ = nome do pacote', `id=${entry.id}`);
  } else {
    reporter.fail(`${prefix}:loader-id`, 'id do __ModuleLoader__ = nome do pacote', `esperado ${packageName}, recebido ${JSON.stringify(entry.id)}`);
  }

  // 2) exports.inject
  const injectList = Array.isArray(exports.inject) ? exports.inject : [];
  const requiredInject = config.inject ?? [];
  const optionalInject = config.optionalInject ?? [];
  const missingInject = requiredInject.filter((name) => !injectList.includes(name));
  const extraInject = injectList.filter((name) => !requiredInject.includes(name) && !optionalInject.includes(name));
  const optionalPresent = injectList.filter((name) => optionalInject.includes(name));
  if (missingInject.length === 0 && extraInject.length === 0) {
    reporter.pass(
      `${prefix}:inject`,
      'serviços injetados',
      `[${injectList.join(', ')}]${optionalPresent.length ? ` (opcionais: ${optionalPresent.join(', ')})` : ''}`,
    );
  } else if (missingInject.length === 0) {
    reporter.warn(`${prefix}:inject`, 'serviços injetados', `extras fora do exigido: [${extraInject.join(', ')}]`);
  } else {
    reporter.fail(
      `${prefix}:inject`,
      'serviços injetados',
      `faltando: [${missingInject.join(', ')}]; recebido [${injectList.join(', ')}]`,
    );
  }
  if (typeof exports.apply !== 'function') {
    reporter.fail(`${prefix}:apply`, 'exports.apply é função', `tipo=${typeof exports.apply}`);
    return;
  }

  // 3) apply(fakeCtx)
  const fake = createClientCtx();
  const started = Date.now();
  let applyResult;
  try {
    applyResult = exports.apply(fake.ctx);
    await Promise.resolve(applyResult);
    reporter.pass(`${prefix}:apply`, 'apply(fakeCtx) executa', `efeitos: ${fake.effectLabels.length}`, {
      durationMs: Date.now() - started,
    });
  } catch (error) {
    reporter.fail(`${prefix}:apply`, 'apply(fakeCtx) executa', error.stack ?? error.message, {
      durationMs: Date.now() - started,
    });
    return;
  }
  if (fake.unknownApi.size > 0) {
    reporter.fail(
      `${prefix}:apply-api`,
      'apply usa somente API do contrato',
      `acessou: ${[...fake.unknownApi].join(', ')}`,
    );
  }
  if (fake.effectLabels.some((label) => !label)) {
    reporter.warn(`${prefix}:effect-labels`, 'ctx.effect com label', 'há efeito sem label (contrato §3.4 pede label)');
  }

  // 4) slots registrados
  const registeredNames = fake.slots.map((record) => record.entry.name);
  const expectedNames = config.slots.map((slot) => slot.name);
  const missingSlots = expectedNames.filter((name) => !registeredNames.includes(name));
  const unexpectedSlots = registeredNames.filter((name) => !expectedNames.includes(name));
  const aliasMatches = [];
  for (const slot of config.slots) {
    if (registeredNames.includes(slot.name)) continue;
    const alias = (slot.aliases ?? []).find((candidate) => registeredNames.includes(candidate));
    if (alias) aliasMatches.push({ expected: slot.name, found: alias });
  }
  if (aliasMatches.length > 0) {
    reporter.warn(
      `${prefix}:slots-alias`,
      'slot do contrato vs alias',
      aliasMatches
        .map((match) => `esperado ${match.expected}, encontrado ${match.found} (aliases: rode com o contrato atualizado)`)
        .join(' | '),
    );
  }
  const realUnexpected = unexpectedSlots.filter(
    (name) => !config.slots.some((slot) => (slot.aliases ?? []).includes(name)),
  );
  if (missingSlots.length === 0 && unexpectedSlots.length === 0) {
    reporter.pass(`${prefix}:slots`, 'slots registrados', registeredNames.join(', '));
  } else if (missingSlots.length === aliasMatches.length && realUnexpected.length === 0) {
    reporter.pass(
      `${prefix}:slots`,
      'slots registrados (via alias)',
      `${registeredNames.join(', ')} — ver WARN de alias`,
    );
  } else {
    reporter.fail(
      `${prefix}:slots`,
      'slots registrados',
      `faltando: [${missingSlots.join(', ')}]; inesperados: [${realUnexpected.join(', ')}]; registrados: [${registeredNames.join(', ')}]`,
    );
  }
  for (const expected of config.slots) {
    if (expected.id) {
      const record = fake.slots.find((candidate) => candidate.entry.name === expected.name);
      if (record) {
        if (record.entry.id === expected.id) {
          reporter.pass(`${prefix}:slot-id:${expected.name}`, `id do slot ${expected.name}`, `id=${record.entry.id}`);
        } else {
          reporter.fail(
            `${prefix}:slot-id:${expected.name}`,
            `id do slot ${expected.name}`,
            `esperado ${JSON.stringify(expected.id)}, recebido ${JSON.stringify(record.entry.id)}`,
          );
        }
      }
    }
    if (expected.order !== undefined) {
      const record = fake.slots.find((candidate) => candidate.entry.name === expected.name);
      if (record) {
        if (record.entry.order === expected.order) {
          reporter.pass(`${prefix}:slot-order:${expected.name}`, `order do slot ${expected.name}`, `order=${record.entry.order}`);
        } else {
          reporter.warn(
            `${prefix}:slot-order:${expected.name}`,
            `order do slot ${expected.name}`,
            `esperado ${expected.order}, recebido ${JSON.stringify(record.entry.order)}`,
          );
        }
      }
    }
  }

  // 5) dicionários i18n
  const dict = fake.dictionaries.get(config.namespace);
  if (!dict) {
    reporter.fail(
      `${prefix}:i18n`,
      'dicionários pt/en registrados',
      `namespace "${config.namespace}" não registrado (registrados: ${[...fake.dictionaries.keys()].join(', ') || 'nenhum'})`,
    );
  } else {
    const ptKeys = countDictKeys(dict.pt);
    const enKeys = countDictKeys(dict.en);
    if (ptKeys >= config.minDictKeys && enKeys >= config.minDictKeys) {
      reporter.pass(`${prefix}:i18n`, 'dicionários pt/en registrados', `pt=${ptKeys} chaves, en=${enKeys} chaves`);
    } else {
      reporter.fail(
        `${prefix}:i18n`,
        'dicionários pt/en registrados',
        `poucas chaves (pt=${ptKeys}, en=${enKeys}, mínimo ${config.minDictKeys})`,
      );
    }
    const ptKeySet = new Set(Object.keys(dict.pt ?? {}));
    const enKeySet = new Set(Object.keys(dict.en ?? {}));
    const onlyPt = [...ptKeySet].filter((key) => !enKeySet.has(key));
    const onlyEn = [...enKeySet].filter((key) => !ptKeySet.has(key));
    if (onlyPt.length === 0 && onlyEn.length === 0) {
      reporter.pass(`${prefix}:i18n-parity`, 'pt e en têm as mesmas chaves', `${ptKeySet.size} chaves`);
    } else {
      reporter.warn(
        `${prefix}:i18n-parity`,
        'pt e en têm as mesmas chaves',
        `só pt: ${onlyPt.slice(0, 10).join(', ')}; só en: ${onlyEn.slice(0, 10).join(', ')}`,
      );
    }
    const emptyValues = Object.entries(dict).flatMap(([locale, table]) =>
      Object.entries(table ?? {}).filter(([, value]) => typeof value !== 'string' || !value.trim()).map(([key]) => `${locale}.${key}`),
    );
    if (emptyValues.length === 0) {
      reporter.pass(`${prefix}:i18n-values`, 'valores de tradução não vazios', 'ok');
    } else {
      reporter.fail(`${prefix}:i18n-values`, 'valores de tradução não vazios', `vazios: ${emptyValues.slice(0, 12).join(', ')}`);
    }
    const t = fake.translate(config.namespace);
    const firstKey = Object.keys(dict.pt ?? {})[0];
    const translated = t(firstKey);
    if (translated && translated !== firstKey) {
      reporter.pass(`${prefix}:i18n-t`, 't(chave) resolve tradução', `t(${firstKey})="${translated}"`);
    } else {
      reporter.warn(`${prefix}:i18n-t`, 't(chave) resolve tradução', `t(${firstKey}) devolveu a própria chave`);
    }
  }

  // 6) CSS injetado
  const sandbox = bundle.sandbox;
  const style = sandbox.document.querySelector(`style[data-plugin="${packageName}"]`);
  if (!style) {
    reporter.fail(`${prefix}:css`, 'CSS injetado em <style data-plugin>', `nenhum style[data-plugin="${packageName}"] no <head>`);
  } else {
    const css = String(style.textContent ?? '');
    if (css.length >= 200) {
      reporter.pass(`${prefix}:css`, 'CSS injetado em <style data-plugin>', `${css.length} bytes`);
    } else {
      reporter.fail(`${prefix}:css`, 'CSS injetado em <style data-plugin>', `CSS muito curto (${css.length} bytes)`);
    }
    if (css.includes('--dsw-')) {
      reporter.pass(`${prefix}:css-tokens`, 'CSS usa tokens --dsw-*', 'ok');
    } else {
      reporter.fail(`${prefix}:css-tokens`, 'CSS usa tokens --dsw-*', 'nenhum token --dsw- encontrado');
    }
    const colors = detectHardcodedColors(css);
    if (colors.length === 0) {
      reporter.pass(`${prefix}:css-no-hex`, 'CSS sem cores hardcoded', 'nenhum hex de cor');
    } else {
      reporter.fail(
        `${prefix}:css-no-hex`,
        'CSS sem cores hardcoded',
        `${colors.length} cor(es) hex: ${[...new Set(colors)].slice(0, 10).join(', ')}`,
      );
    }
  }

  // 7) debug hook
  const hook = sandbox.__dshVoiceDebug?.[config.debugKey];
  if (hook && typeof hook.rpc === 'function') {
    reporter.pass(`${prefix}:debug-hook`, `window.__dshVoiceDebug.${config.debugKey}`, `plugin=${hook.plugin}, version=${hook.version}`);
    try {
      const value = await hook.rpc('status', {});
      const call = fake.rpcCalls.at(-1);
      const channelOk = call && call.channel === config.channel;
      if (channelOk && value && typeof value === 'object') {
        reporter.pass(
          `${prefix}:debug-rpc`,
          'debug hook roteia RPC pelo canal do contrato',
          `rpc("status") -> canal ${call.channel}, valor ${JSON.stringify(value).slice(0, 120)}`,
        );
      } else {
        reporter.fail(
          `${prefix}:debug-rpc`,
          'debug hook roteia RPC pelo canal do contrato',
          `canal esperado ${config.channel}, recebido ${JSON.stringify(call?.channel)}; valor=${JSON.stringify(value)?.slice(0, 200)}`,
        );
      }
    } catch (error) {
      reporter.fail(`${prefix}:debug-rpc`, 'debug hook roteia RPC pelo canal do contrato', error.stack ?? error.message);
    }
  } else {
    reporter.fail(
      `${prefix}:debug-hook`,
      `window.__dshVoiceDebug.${config.debugKey}`,
      `ausente ou sem rpc: ${JSON.stringify(sandbox.__dshVoiceDebug ?? null)}`,
    );
  }

  // 8) render SSR de cada componente registrado
  for (const record of fake.slots) {
    const { entry: slotEntry, Component } = record;
    const label = slotEntry.name;
    if (typeof Component !== 'function') {
      reporter.fail(`${prefix}:render:${label}`, `render SSR ${label}`, `componente não é função: ${typeof Component}`);
      continue;
    }
    let injected = {};
    if (typeof slotEntry.inject === 'function') {
      try {
        injected = slotEntry.inject('qa-session') ?? {};
      } catch (error) {
        reporter.fail(`${prefix}:render:${label}`, `render SSR ${label}`, `inject() lançou: ${error.message}`);
        continue;
      }
    }
    const props = {
      ...(config.props[label] ?? {}),
      ...injected,
      t: fake.translate(slotEntry.locale ?? config.namespace),
    };
    try {
      const html = renderToStaticMarkup(React.createElement(Component, props));
      const allowEmpty = (config.allowEmptyRender ?? []).includes(label);
      if (typeof html === 'string' && html.length > 0) {
        reporter.pass(`${prefix}:render:${label}`, `render SSR ${label}`, `${html.length} bytes de HTML`);
      } else if (typeof html === 'string' && allowEmpty) {
        reporter.pass(
          `${prefix}:render:${label}`,
          `render SSR ${label}`,
          'HTML vazio — comportamento defensivo aceito (props mínimas sem sessão/mensagem conhecida)',
        );
        continue;
      } else {
        reporter.fail(`${prefix}:render:${label}`, `render SSR ${label}`, `HTML vazio (${typeof html})`);
        continue;
      }
      const markers = config.renderExpect[label] ?? [];
      for (const marker of markers) {
        if (html.includes(marker)) {
          reporter.pass(`${prefix}:marker:${label}:${marker}`, `marcador ${marker} em ${label}`, 'presente');
        } else {
          reporter.fail(
            `${prefix}:marker:${label}:${marker}`,
            `marcador ${marker} em ${label}`,
            `não encontrado no HTML renderizado (contrato de seletores do E2E)`,
          );
        }
      }
    } catch (error) {
      reporter.fail(`${prefix}:render:${label}`, `render SSR ${label}`, `lançou: ${error.stack ?? error.message}`);
    }
  }

  // 9) dispose
  try {
    if (typeof applyResult === 'function') applyResult();
    fake.disposeAll();
    const styleAfter = sandbox.document.querySelector(`style[data-plugin="${packageName}"]`);
    const slotsAfter = fake.slots.length;
    if (!styleAfter) {
      reporter.pass(`${prefix}:dispose-css`, 'dispose remove o <style>', 'style removido do head');
    } else {
      reporter.fail(`${prefix}:dispose-css`, 'dispose remove o <style>', 'style continua no head após dispose');
    }
    if (slotsAfter === 0) {
      reporter.pass(`${prefix}:dispose-slots`, 'dispose desregistra slots', '0 slots registrados');
    } else {
      reporter.fail(`${prefix}:dispose-slots`, 'dispose desregistra slots', `${slotsAfter} slot(s) ainda registrados`);
    }
    if (fake.warnings.length === 0) {
      reporter.pass(`${prefix}:dispose-clean`, 'dispose sem erros', 'ok');
    } else {
      reporter.fail(`${prefix}:dispose-clean`, 'dispose sem erros', fake.warnings.join(' | '));
    }
  } catch (error) {
    reporter.fail(`${prefix}:dispose`, 'dispose', error.stack ?? error.message);
  }

  debug.slots = registeredNames;
  debug.effectLabels = fake.effectLabels;
  debug.rpcCalls = fake.rpcCalls.length;
  return debug;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(ARTIFACTS_DIR);
  const reporter = new Reporter('smoke-client', {
    jsonOut: options.jsonOut ?? path.join(ARTIFACTS_DIR, 'smoke-client-report.json'),
  });

  const names = options.packages.length ? options.packages : Object.keys(CONFIG);
  if (options.packages.some((name) => !CONFIG[name])) {
    console.error(`smoke-client: pacote desconhecido (use ${Object.keys(CONFIG).join(', ')})`);
    process.exit(2);
  }

  console.log('smoke-client: validando bundles de cliente (vm + react-dom/server)');
  for (const name of names) {
    try {
      await testPlugin(name, CONFIG[name], reporter, options);
    } catch (error) {
      reporter.fail(`${name}:unexpected`, 'erro inesperado no smoke', error.stack ?? error.message);
    }
  }

  reporter.finish({ strict: options.strict });
}

main().catch((error) => {
  console.error('smoke-client: erro fatal:', error);
  process.exit(1);
});

