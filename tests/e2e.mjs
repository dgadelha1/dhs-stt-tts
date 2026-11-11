#!/usr/bin/env node
/**
 * tests/e2e.mjs — E2E real do DSH Voice Suite (Puppeteer-core + Chrome do sistema).
 *
 * Abre o dev server (profile voice-dev, porta 3099) com o URL+token, valida o
 * boot sem erros, a presença dos controles e das seções de Settings, e chama o
 * RPC real pelos hooks de diagnóstico do contrato:
 *   window.__dshVoiceDebug.stt.rpc(endpoint, payload)
 *   window.__dshVoiceDebug.tts.rpc(endpoint, payload)
 *
 * Casos principais:
 *   - boot sem console.error/pageerror/requestfailed (ignora erro conhecido da conta);
 *   - hooks STT/TTS presentes no boot; botões/composer/Settings;
 *   - status STT (ready, GPU/CUDA, limites) e TTS (engines edge+sapi);
 *   - prepareStatus com fase/progresso;
 *   - synthesize pt-BR/en-US (edge exigido com 1 retry; sapi offline separado);
 *   - transcribe dos WAVs fixture pt/en com tolerância a acento/caixa;
 *   - FLUXO REAL DE MICROFONE com áudio fake de arquivo WAV 16 kHz do fixture:
 *     clica no mic, grava, para, aguarda transcribing e confere o texto no composer;
 *   - auto-leitura (toggle) e limitações de playback headless;
 *   - hot-apply (reinstalar plugins já instalados + reload) via --hot-apply;
 *   - modo --expect-missing: runtime ausente => status.ready=false + erro acionável.
 *
 * Gera tests/artifacts/e2e-report.json e tests/artifacts/e2e-report.md (+ screenshot),
 * limpa o browser sempre, e usa timeouts generosos.
 *
 * Uso:
 *   node tests/e2e.mjs [--url <url-com-token>] [--profile voice-dev]
 *     [--expect-missing] [--hot-apply] [--headed] [--strict]
 *     [--artifacts-suffix missing] [--keep-trace]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';
import {
  ARTIFACTS_DIR,
  FIXTURES_DIR,
  PACKAGES_DIR,
  ROOT,
  Reporter,
  ensureDir,
  fmtMs,
  loadFixtureManifest,
  matchKeywordGroups,
  readFixtureWavBase64,
  readJson,
  redactUrl,
  tail,
  writeJson,
} from './lib/util.mjs';
import { chromeHelp, dshHelp, resolveChrome, resolveDshCli } from './lib/chrome.mjs';

const execFileAsync = promisify(execFile);
const KNOWN_CONSOLE_ERRORS = [/\[deepseek-account\] account read failed/i];
const KNOWN_NETWORK_IGNORES = [/favicon\.ico/i, /\.map(\?|$)/i, /\/__hmr/i];

function parseArgs(argv) {
  const options = {
    profile: 'voice-dev',
    port: 3099,
    url: null,
    chrome: null,
    dshCli: null,
    expectMissing: false,
    hotApply: false,
    headed: false,
    strict: false,
    suffix: '',
    keepTrace: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      return argv[index];
    };
    if (arg === '--url') options.url = next();
    else if (arg === '--profile') options.profile = next();
    else if (arg === '--chrome') options.chrome = next();
    else if (arg === '--dsh-cli') options.dshCli = next();
    else if (arg === '--artifacts-suffix') options.suffix = next();
    else if (arg === '--expect-missing') options.expectMissing = true;
    else if (arg === '--hot-apply') options.hotApply = true;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--keep-trace') options.keepTrace = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('uso: node tests/e2e.mjs [--url URL] [--profile voice-dev] [--expect-missing] [--hot-apply] [--headed] [--strict] [--artifacts-suffix S]');
      process.exit(0);
    }
  }
  return options;
}

function artifactName(base, suffix, extension) {
  return path.join(ARTIFACTS_DIR, `${base}${suffix ? `-${suffix}` : ''}.${extension}`);
}

/** URL com token: argumento > state file do dev-server.ps1 > E2E_URL. */
function resolveUrl(options) {
  if (options.url) return options.url;
  if (process.env.E2E_URL) return process.env.E2E_URL;
  const stateFile = path.join(ARTIFACTS_DIR, 'dev-server.json');
  if (fs.existsSync(stateFile)) {
    const state = readJson(stateFile);
    if (state.url) return state.url;
  }
  return null;
}

function launchOptions(options, headless) {
  const fakeAudio = path.join(FIXTURES_DIR, 'pt-br.wav').replace(/\\/g, '/');
  return {
    executablePath: options.chromePath,
    headless: headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1440,980',
      '--lang=pt-BR',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fakeAudio}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
    ],
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 180000,
  };
}

async function dismissPreviewDialog(page) {
  try {
    const clicked = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!dialog) return false;
      const buttons = [...dialog.querySelectorAll('button')];
      const target = buttons.find((button) => /continuar|entendi|ok|fechar/i.test(button.innerText ?? ''))
        ?? buttons[buttons.length - 1];
      if (!target) return false;
      target.click();
      return true;
    });
    if (clicked) await new Promise((resolve) => setTimeout(resolve, 800));
    return clicked;
  } catch {
    return false;
  }
}

async function openSettings(page) {
  // 1) menu da conta (sidebar) → item "Configurações"
  const accountOpened = await page.evaluate(() => {
    const button = document.querySelector('[data-slot="sidebar.settings"] button[aria-label="Menu da conta"]')
      ?? [...document.querySelectorAll('button')].find((candidate) =>
        /menu da conta|account menu/i.test(candidate.getAttribute('aria-label') ?? ''),
      );
    if (!button) return false;
    button.click();
    return true;
  });
  if (!accountOpened) return { ok: false, reason: 'botão "Menu da conta" não encontrado' };
  await new Promise((resolve) => setTimeout(resolve, 700));
  const clickedSettings = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], button')];
    const target = candidates.find((element) =>
      /^configura(ç|c)(õ|o)es?$/i.test((element.innerText ?? '').trim().split('\n')[0])
      || /configura|settings/i.test(`${element.innerText ?? ''} ${element.getAttribute('aria-label') ?? ''}`),
    );
    if (!target) return null;
    target.click();
    return (target.innerText ?? '').trim().split('\n')[0];
  });
  if (!clickedSettings) return { ok: false, reason: 'item "Configurações" não encontrado no menu da conta' };
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const dialog = await page.evaluate(() => {
    const candidate = [...document.querySelectorAll('[role="dialog"]')].find((element) =>
      /configura|settings/i.test(element.innerText ?? ''),
    );
    return candidate ? (candidate.innerText ?? '').slice(0, 300) : null;
  });
  if (!dialog) return { ok: false, reason: 'diálogo de Configurações não abriu' };
  return { ok: true, clickedSettings, dialog };
}

async function clickSettingsNav(page, labelPattern) {
  const clicked = await page.evaluate((pattern) => {
    const regex = new RegExp(pattern, 'i');
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((element) =>
      /configura|settings/i.test(element.innerText ?? ''),
    );
    if (!dialog) return null;
    const candidates = [...dialog.querySelectorAll('button, [role="tab"]')];
    const target = candidates.find((element) => {
      const text = (element.innerText ?? '').trim().split('\n')[0];
      return regex.test(text);
    });
    if (!target) return null;
    target.click();
    return (target.innerText ?? '').trim().split('\n')[0];
  }, labelPattern.source ?? labelPattern);
  await new Promise((resolve) => setTimeout(resolve, 900));
  return clicked;
}

function parseState(value) {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'valor não é objeto' };
  return { ok: true, value };
}

async function callRpc(page, kind, endpoint, payload, timeoutMs = 120000) {
  return page.evaluate(
    async ({ kindName, endpointName, payloadValue, timeout }) => {
      const hook = window.__dshVoiceDebug?.[kindName];
      if (!hook || typeof hook.rpc !== 'function') {
        return { ok: false, error: { message: `window.__dshVoiceDebug.${kindName}.rpc ausente`, code: 'no-hook' } };
      }
      const start = Date.now();
      try {
        const value = await Promise.race([
          hook.rpc(endpointName, payloadValue),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout local de ${timeout}ms`)), timeout)),
        ]);
        return { ok: true, value, ms: Date.now() - start };
      } catch (error) {
        return {
          ok: false,
          ms: Date.now() - start,
          error: { message: String(error?.message ?? error), code: error?.code ?? 'thrown' },
        };
      }
    },
    { kindName: kind, endpointName: endpoint, payloadValue: payload, timeout: timeoutMs },
  );
}

async function waitForDebugHooks(page, timeoutMs = 90000) {
  await page.waitForFunction(
    () => Boolean(
      window.__dshVoiceDebug
      && window.__dshVoiceDebug.stt && typeof window.__dshVoiceDebug.stt.rpc === 'function'
      && window.__dshVoiceDebug.tts && typeof window.__dshVoiceDebug.tts.rpc === 'function',
    ),
    { timeout: timeoutMs, polling: 250 },
  );
}

async function waitForSelectorCount(page, selector, minimum, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
    if (count >= minimum) return count;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
}

async function readSttState(page) {
  return page.evaluate(() => {
    const button = document.querySelector('[data-voice-stt-button]');
    return button ? {
      state: button.getAttribute('data-voice-stt-state'),
      dataState: button.getAttribute('data-state'),
      ariaPressed: button.getAttribute('aria-pressed'),
      disabled: button.hasAttribute('disabled'),
    } : null;
  });
}

async function readComposerText(page) {
  return page.evaluate(() => {
    const selectors = ['[data-composer-input]', '[contenteditable="true"]', '.ProseMirror'];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      // innerText e textContent carregam o MESMO texto no contenteditable:
      // usar um OU outro (concatenar duplicaria o conteúdo).
      const inner = (element.innerText ?? '').trim();
      const content = (element.textContent ?? '').trim();
      const text = inner || content;
      if (text) return text;
    }
    return '';
  });
}

/** Limpa o composer (útil antes de repetir o fluxo de micrófono). */
async function clearComposer(page) {
  try {
    const composer = await page.$('[data-composer-input]');
    if (!composer) return false;
    await composer.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const text = await readComposerText(page);
    return text.trim().length === 0;
  } catch {
    return false;
  }
}

async function closeSettingsDialog(page) {
  try {
    await page.keyboard.press('Escape');
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await page.evaluate(() => ![...document.querySelectorAll('[role="dialog"]')].some((dialog) =>
      /configura|settings/i.test(dialog.innerText ?? '')));
  } catch {
    return false;
  }
}

async function waitForSttState(page, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readSttState(page);
    if (last && wanted.includes(last.state)) return { ok: true, last };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, last };
}

async function runCase(reporter, id, name, callback, extra = {}) {
  const started = Date.now();
  try {
    const result = await callback();
    const durationMs = Date.now() - started;
    if (result && result.status === 'skip') {
      reporter.skip(id, name, result.detail, { durationMs, evidence: result.evidence });
      return { status: 'skip', ...result };
    }
    if (result && result.status === 'warn') {
      reporter.warn(id, name, result.detail, { durationMs, evidence: result.evidence });
      return { status: 'warn', ...result };
    }
    if (result && result.ok === false) {
      reporter.fail(id, name, result.detail ?? 'falhou', { durationMs, evidence: result.evidence });
      return { status: 'fail', ...result };
    }
    reporter.pass(id, name, result?.detail ?? 'ok', { durationMs, evidence: result?.evidence });
    return { status: 'pass', ...(result ?? {}) };
  } catch (error) {
    reporter.fail(id, name, error.stack ?? error.message, { durationMs: Date.now() - started });
    return { status: 'fail', error };
  }
}

function filterConsoleErrors(consoleMessages) {
  return consoleMessages
    .filter((entry) => entry.type === 'error')
    .filter((entry) => !KNOWN_CONSOLE_ERRORS.some((regex) => regex.test(entry.text)));
}

function filterNetworkFailures(networkEntries) {
  return networkEntries.filter((entry) => !KNOWN_NETWORK_IGNORES.some((regex) => regex.test(entry.url)));
}

/** Escreve o relatório markdown final a partir do Reporter + metadados. */
function writeMarkdownReport(reporter, meta) {
  const lines = [];
  lines.push(`# E2E — DSH Voice Suite${meta.suffix ? ` (${meta.suffix})` : ''}`);
  lines.push('');
  lines.push(`- **Data**: ${meta.startedAt}`);
  lines.push(`- **URL**: ${redactUrl(meta.url)}`);
  lines.push(`- **Profile**: ${meta.profile} (porta ${meta.port})`);
  lines.push(`- **Chrome**: ${meta.chromeVersion ?? meta.chrome}`);
  lines.push(`- **Modo**: ${meta.expectMissing ? 'runtime ausente (expect-missing)' : 'runtime preparado'}${meta.headless ? ' / headless' : ' / headed'}`);
  lines.push(`- **Duração**: ${fmtMs(meta.durationMs)}`);
  lines.push(`- **Ambiente**: Node ${process.version}, ${os.platform()} ${os.release()}`);
  lines.push('');
  const counts = reporter.counts;
  lines.push('## Resumo');
  lines.push('');
  lines.push('| Resultado | Casos |');
  lines.push('|---|---|');
  lines.push(`| ✅ PASS | ${counts.pass} |`);
  lines.push(`| ❌ FAIL | ${counts.fail} |`);
  lines.push(`| ⚠️ WARN | ${counts.warn} |`);
  lines.push(`| ⏭️ SKIP | ${counts.skip} |`);
  lines.push('');
  lines.push('## Casos');
  lines.push('');
  for (const entry of reporter.cases) {
    const icon = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️' }[entry.status] ?? '•';
    lines.push(`### ${icon} ${entry.id} — ${entry.name}`);
    lines.push('');
    lines.push(`- Status: **${entry.status.toUpperCase()}**${entry.durationMs ? ` (${fmtMs(entry.durationMs)})` : ''}`);
    if (entry.detail) {
      lines.push('- Detalhe:');
      lines.push('```');
      lines.push(String(entry.detail));
      lines.push('```');
    }
    lines.push('');
  }
  if (meta.consoleErrors.length > 0) {
    lines.push('## Console errors não esperados');
    lines.push('');
    lines.push('```');
    lines.push(meta.consoleErrors.slice(0, 40).join('\n'));
    lines.push('```');
    lines.push('');
  }
  if (meta.pageErrors.length > 0) {
    lines.push('## Page errors');
    lines.push('');
    lines.push('```');
    lines.push(meta.pageErrors.slice(0, 40).join('\n'));
    lines.push('```');
    lines.push('');
  }
  if (meta.networkFailures.length > 0) {
    lines.push('## Requisições falhas (filtradas)');
    lines.push('');
    lines.push('```');
    lines.push(meta.networkFailures.slice(0, 40).map((entry) => `${entry.url} :: ${entry.reason}`).join('\n'));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Screenshots');
  lines.push('');
  for (const screenshot of meta.screenshots) {
    const relative = path.relative(ROOT, screenshot).split(path.sep).join('/');
    lines.push(`- [${relative}](${relative})`);
  }
  lines.push('');
  if (meta.limitations.length > 0) {
    lines.push('## Limitações / observações');
    lines.push('');
    for (const limitation of meta.limitations) lines.push(`- ${limitation}`);
    lines.push('');
  }
  const file = artifactName('e2e-report', meta.suffix, 'md');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(ARTIFACTS_DIR);
  const suffix = options.suffix || (options.expectMissing ? 'missing' : '');
  const reporter = new Reporter(`e2e${suffix ? `-${suffix}` : ''}`, {
    jsonOut: artifactName('e2e-report', suffix, 'json'),
  });
  const startedAt = new Date();
  const screenshots = [];
  const limitations = [];
  const consoleMessages = [];
  const pageErrors = [];
  const networkEntries = [];
  const meta = {
    suffix,
    profile: options.profile,
    port: options.port,
    expectMissing: options.expectMissing,
    headless: !options.headed,
    chrome: null,
    startedAt: startedAt.toISOString(),
    url: 'desconhecido',
    chromeVersion: null,
    durationMs: 0,
    consoleErrors: [],
    pageErrors,
    networkFailures: [],
    screenshots,
    limitations,
  };

  const url = resolveUrl(options);
  if (!url) {
    console.error('e2e: sem URL. Suba o dev server (scripts/dev-server.ps1) ou passe --url.');
    process.exit(2);
  }
  meta.url = url;
  // Navegador portátil: --chrome/CHROME_PATH/PUPPETEER_EXECUTABLE_PATH -> padrões do SO.
  options.chromePath = resolveChrome(options.chrome);
  meta.chrome = options.chromePath;
  if (!options.chromePath) {
    console.error('e2e: navegador Chrome/Edge não encontrado.');
    for (const hint of chromeHelp()) console.error(`  - ${hint}`);
    process.exit(2);
  }
  const fixtureManifest = loadFixtureManifest();
  const ptFixture = fixtureManifest.fixtures['pt-br'];
  const enFixture = fixtureManifest.fixtures['en-us'];
  const ptWav = readFixtureWavBase64(ptFixture.file);
  const enWav = readFixtureWavBase64(enFixture.file);

  let browser = null;
  let page = null;
  let pageDialogDismissed = false;
  const screenshot = async (name) => {
    const file = artifactName(name, suffix, 'png');
    try {
      await page.screenshot({ path: file, fullPage: false });
      screenshots.push(file);
      return file;
    } catch {
      return null;
    }
  };

  try {
    browser = await puppeteer.launch(launchOptions(options, !options.headed));
    page = await browser.newPage();
    page.setDefaultTimeout(90000);
    meta.chromeVersion = await browser.version();
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() });
    });
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('requestfailed', (request) => {
      networkEntries.push({ url: request.url(), reason: request.failure()?.errorText ?? 'requestfailed' });
    });
    page.on('response', (response) => {
      if (response.status() >= 400) networkEntries.push({ url: response.url(), reason: `HTTP ${response.status()}` });
    });

    console.log(`e2e: abrindo ${redactUrl(url)}`);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await runCase(reporter, 'boot-http', 'página carrega com o token', async () => {
      const status = response?.status();
      const html = await page.content();
      if (status === 200 && html.includes('dsh')) {
        return { detail: `HTTP ${status}, ${html.length} bytes de HTML` };
      }
      return { ok: false, detail: `HTTP ${status}, ${html.length} bytes` };
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    pageDialogDismissed = await dismissPreviewDialog(page);
    await runCase(reporter, 'boot-preview-dismiss', 'aviso de prévia tratado', async () =>
      (pageDialogDismissed
        ? { detail: 'diálogo "Aviso de visualização" fechado via Continuar' }
        : { status: 'skip', detail: 'diálogo de prévia não apareceu (já dispensado no profile)' }));

    await runCase(reporter, 'boot-hooks', 'hooks __dshVoiceDebug.stt/tts no boot', async () => {
      await waitForDebugHooks(page, 90000);
      const hooks = await page.evaluate(() => ({
        stt: window.__dshVoiceDebug?.stt && {
          plugin: window.__dshVoiceDebug.stt.plugin,
          version: window.__dshVoiceDebug.stt.version,
          rpc: typeof window.__dshVoiceDebug.stt.rpc,
        },
        tts: window.__dshVoiceDebug?.tts && {
          plugin: window.__dshVoiceDebug.tts.plugin,
          version: window.__dshVoiceDebug.tts.version,
          rpc: typeof window.__dshVoiceDebug.tts.rpc,
        },
      }));
      const ok = hooks.stt?.rpc === 'function' && hooks.tts?.rpc === 'function';
      return { ok, detail: JSON.stringify(hooks), evidence: hooks };
    });

    await runCase(reporter, 'dom-mic', 'botão do microfone no composer', async () => {
      const count = await waitForSelectorCount(page, '[data-voice-stt-button]', 1, 30000);
      const state = await readSttState(page);
      if (count >= 1 && state) {
        return { detail: `presente; data-voice-stt-state=${state.state}`, evidence: state };
      }
      return { ok: false, detail: `count=${count}` };
    });
    await runCase(reporter, 'dom-mic-lang', 'seletor de idioma do ditado', async () => {
      const value = await page.evaluate(() => document.querySelector('[data-voice-stt-lang]')?.getAttribute('data-voice-stt-lang'));
      return value ? { detail: `data-voice-stt-lang=${value}` } : { ok: false, detail: 'botão de idioma ausente' };
    });
    await runCase(reporter, 'dom-tts-controls', 'controles TTS globais (falar + auto)', async () => {
      const counts = await page.evaluate(() => ({
        button: document.querySelectorAll('[data-voice-tts-button]').length,
        auto: document.querySelectorAll('[data-voice-tts-auto]').length,
        state: document.querySelector('[data-voice-tts-button]')?.getAttribute('data-state'),
        autoOn: document.querySelector('[data-voice-tts-auto]')?.getAttribute('data-on'),
      }));
      const ok = counts.button >= 1 && counts.auto >= 1;
      return { ok, detail: JSON.stringify(counts), evidence: counts };
    });
    await runCase(reporter, 'dom-composer', 'composer contenteditable presente', async () => {
      const composer = await page.evaluate(() => {
        const element = document.querySelector('[data-composer-input]')
          ?? document.querySelector('[contenteditable="true"]');
        return element ? { tag: element.tagName, editable: element.getAttribute('contenteditable') } : null;
      });
      return composer ? { detail: JSON.stringify(composer) } : { ok: false, detail: 'composer não encontrado' };
    });
    await screenshot('e2e-boot');

    // Settings
    await runCase(reporter, 'settings-open', 'abrir Settings pela UI', async () => {
      const result = await openSettings(page);
      if (!result.ok) return { ok: false, detail: result.reason };
      return { detail: `configurações abertas (item "${result.clickedSettings}")` };
    });
    await runCase(reporter, 'settings-stt', 'seção "Ditado por voz" em Settings', async () => {
      const clicked = await clickSettingsNav(page, /ditado por voz|dictation|voice stt/i);
      const counts = await page.evaluate(() => ({
        container: document.querySelectorAll('[data-voice-stt-settings]').length,
        text: (document.querySelector('[data-voice-stt-settings]')?.innerText ?? '').slice(0, 800),
      }));
      const ok = counts.container >= 1 && counts.text.length > 20;
      await screenshot('e2e-settings-stt');
      if (!ok) return { ok: false, detail: `navClicada=${clicked}; container=${counts.container}; texto="${counts.text.slice(0, 200)}"` };
      return { detail: `nav="${clicked}", ${counts.text.length} chars`, evidence: counts.text.slice(0, 600) };
    });
    await runCase(reporter, 'settings-tts', 'seção "Voz (TTS)" em Settings', async () => {
      const clicked = await clickSettingsNav(page, /voz \(tts\)|text.to.speech|voz/i);
      const counts = await page.evaluate(() => ({
        container: document.querySelectorAll('[data-voice-tts-settings]').length,
        text: (document.querySelector('[data-voice-tts-settings]')?.innerText ?? '').slice(0, 800),
      }));
      const ok = counts.container >= 1 && counts.text.length > 20;
      await screenshot('e2e-settings-tts');
      // fecha o diálogo: o fluxo de microfone precisa do composer livre
      const closed = await closeSettingsDialog(page);
      limitations.push(`Settings fechado após os testes: ${closed ? 'sim (Esc)' : 'NÃO — overlay pode interferir no clique do mic'}`);
      if (!ok) return { ok: false, detail: `navClicada=${clicked}; container=${counts.container}; texto="${counts.text.slice(0, 200)}"` };
      return { detail: `nav="${clicked}", ${counts.text.length} chars`, evidence: counts.text.slice(0, 600) };
    });

    // RPC status
    await runCase(reporter, 'rpc-stt-status', 'RPC STT status', async () => {
      const result = await callRpc(page, 'stt', 'status', {}, 60000);
      if (!result.ok) return { ok: false, detail: `erro: ${result.error.message}`, evidence: result.error };
      const value = result.value ?? {};
      const text = JSON.stringify(value);
      const ready = value.ready === true || value.runtime?.ready === true || value.runtime?.installed === true;
      const detail = tail(text, 900);
      if (options.expectMissing) {
        if (ready) return { ok: false, detail: `modo expect-missing, mas status.ready=true: ${detail}` };
        return { detail: `ready=false (esperado): ${detail}`, evidence: value };
      }
      if (!ready) return { ok: false, detail: `runtime não está pronto para o E2E: ${detail}`, evidence: value };
      return { detail, evidence: value };
    });
    await runCase(reporter, 'rpc-tts-status', 'RPC TTS status', async () => {
      const result = await callRpc(page, 'tts', 'status', {}, 60000);
      if (!result.ok) return { ok: false, detail: `erro: ${result.error.message}` };
      const text = JSON.stringify(result.value ?? {});
      const hasEdge = /edge/i.test(text);
      const hasSapi = /sapi/i.test(text);
      return {
        ok: hasEdge && hasSapi,
        detail: tail(text, 900),
        evidence: result.value,
      };
    });
    await runCase(reporter, 'rpc-stt-prepare-status', 'RPC STT prepareStatus (fase/progresso)', async () => {
      const result = await callRpc(page, 'stt', 'prepareStatus', {}, 60000);
      if (!result.ok) return { ok: false, detail: `erro: ${result.error.message}` };
      const value = result.value ?? {};
      const phase = value.phase ?? value.status ?? value.state;
      const progress = value.progress;
      const progressOk = typeof progress === 'number' && progress >= 0 && progress <= 1;
      const phaseOk = typeof phase === 'string' && phase.length > 0;
      if (!phaseOk && !progressOk) return { ok: false, detail: `sem fase/progresso: ${tail(JSON.stringify(value), 400)}` };
      if (options.expectMissing) {
        return { detail: `phase=${phase}, progress=${progress} (runtime ausente)`, evidence: value };
      }
      return { detail: `phase=${phase}, progress=${progress}`, evidence: value };
    });

    // STT transcrição real (RPC)
    for (const [id, fixture, wav] of [
      ['rpc-stt-transcribe-pt', ptFixture, ptWav],
      ['rpc-stt-transcribe-en', enFixture, enWav],
    ]) {
      await runCase(reporter, id, `RPC STT transcribe ${fixture.locale} (fixture)`, async () => {
        const result = await callRpc(page, 'stt', 'transcribe', {
          audioBase64: wav.base64,
          language: fixture.lang,
        }, 180000);
        if (!result.ok) {
          if (options.expectMissing) {
            const message = String(result.error?.message ?? '');
            const actionable = /prepar|modelo|model|venv|runtime|instal/i.test(message);
            return actionable
              ? { detail: `erro acionável como esperado: ${message}` }
              : { ok: false, detail: `erro sem dica acionável: ${message}` };
          }
          return { ok: false, detail: `erro RPC: ${result.error.message}`, evidence: result.error };
        }
        const text = String(result.value?.text ?? '');
        const match = matchKeywordGroups(text, fixture.requireGroups, fixture.minGroups);
        const detail = `texto="${text}" (${result.ms}ms; esperado ${match.matched}/${match.total} grupos: ${match.ok})`;
        if (options.expectMissing) return { detail };
        return { ok: match.ok, detail, evidence: { text, match } };
      });
    }

    // TTS síntese (edge com retry; sapi offline)
    for (const [id, lang, fixtureKey] of [
      ['rpc-tts-synthesize-pt', 'pt-BR', 'pt-BR'],
      ['rpc-tts-synthesize-en', 'en-US', 'en-US'],
    ]) {
      await runCase(reporter, id, `RPC TTS synthesize ${lang} (edge, 1 retry)`, async () => {
        const ttsSpec = fixtureManifest.tts[fixtureKey];
        const text = ttsSpec.texts[0];
        let lastError = null;
        let sawSapiFallback = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const result = await callRpc(page, 'tts', 'synthesize', { text, lang, engine: 'edge' }, 120000);
          if (result.ok) {
            const value = result.value ?? {};
            const bytes = Buffer.from(String(value.audioBase64 ?? ''), 'base64').length;
            const mime = String(value.mime ?? '');
            const engine = String(value.engine ?? '');
            const mimeOk = mime.startsWith('audio/') && bytes > 1024;
            if (engine === 'edge' && /audio\/(mpeg|mp3)/.test(mime) && mimeOk) {
              return { detail: `edge OK: ${bytes} bytes, mime=${mime}, voice=${value.voice} (tentativa ${attempt})` };
            }
            if (engine === 'sapi' && mimeOk) {
              sawSapiFallback = true;
              lastError = `engine devolveu sapi para 'edge'`;
              continue;
            }
            return { ok: false, detail: `resposta inválida: bytes=${bytes}, mime=${mime}, engine=${engine}` };
          }
          lastError = result.error.message;
          if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (options.expectMissing) {
          return { status: 'skip', detail: `edge indisponível no modo expect-missing: ${lastError}` };
        }
        if (sawSapiFallback) {
          return { status: 'warn', detail: `edge falhou após retry; SAPI respondeu (fallback): ${lastError}` };
        }
        return { ok: false, detail: `edge falhou duas vezes: ${lastError}` };
      });
    }
    await runCase(reporter, 'rpc-tts-sapi', 'RPC TTS synthesize SAPI (offline)', async () => {
      const text = fixtureManifest.tts['pt-BR'].texts[0];
      const result = await callRpc(page, 'tts', 'synthesize', { text, lang: 'pt-BR', engine: 'sapi' }, 120000);
      if (!result.ok) return { ok: false, detail: `erro: ${result.error.message}` };
      const value = result.value ?? {};
      const bytes = Buffer.from(String(value.audioBase64 ?? ''), 'base64').length;
      const mime = String(value.mime ?? '');
      const ok = value.engine === 'sapi' && mime.startsWith('audio/') && bytes > 1024;
      return { ok, detail: `engine=${value.engine}, mime=${mime}, ${bytes} bytes, voice=${value.voice}` };
    });

    // Fluxo real de microfone (fake capture com o WAV fixture pt-BR)
    const micFlow = async () => {
      const before = await readSttState(page);
      if (!before) return { ok: false, detail: 'botão do microfone ausente' };
      await page.click('[data-voice-stt-button]');
      const started = await waitForSttState(page, ['requesting', 'recording'], 15000);
      if (!started.ok) return { ok: false, detail: `não entrou em recording: ${JSON.stringify(started.last)}` };
      if (started.last.state === 'requesting') await waitForSttState(page, ['recording'], 15000);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const during = await readSttState(page);
      await screenshot('e2e-mic-recording');
      await page.click('[data-voice-stt-button]');
      const transcribing = await waitForSttState(page, ['transcribing'], 20000);
      const done = await waitForSttState(page, ['idle'], 180000);
      // o texto entra no composer de forma assíncrona após a transcrição:
      // aguarda aparecer (evita falso-negativo que dispararia o retry headed).
      let text = '';
      let match = matchKeywordGroups('', ptFixture.requireGroups, ptFixture.minGroups);
      const textDeadline = Date.now() + 20000;
      while (Date.now() < textDeadline) {
        text = await readComposerText(page);
        match = matchKeywordGroups(text, ptFixture.requireGroups, ptFixture.minGroups);
        if (match.ok) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await screenshot('e2e-mic-done');
      const detail = `estado durante=${JSON.stringify(during)}; transcribing=${transcribing.ok}; texto no composer="${text.slice(0, 300)}"; grupos=${match.matched}/${match.total}`;
      if (!done.ok) return { ok: false, detail: `não voltou a idle: ${JSON.stringify(done.last)}` };
      return { ok: match.ok, detail, evidence: { text, match: match.ok, matched: match.matched } };
    };
    await runCase(reporter, 'mic-flow', 'fluxo real de microfone: gravar → transcrever → inserir no composer', async () => {
      if (options.expectMissing) return { status: 'skip', detail: 'runtime ausente por definição no modo expect-missing' };
      const result = await micFlow();
      if (result.ok) return result;
      limitations.push(`mic-flow headless falhou (${tail(String(result.detail), 400)}); repetido em modo headed`);
      // fallback headed (headless pode não suportar captura de áudio em alguns ambientes)
      if (!options.headed) {
        try {
          await browser.close();
        } catch { /* noop */ }
        browser = await puppeteer.launch(launchOptions(options, false));
        page = await browser.newPage();
        page.setDefaultTimeout(120000);
        page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await new Promise((resolve) => setTimeout(resolve, 4000));
        await dismissPreviewDialog(page);
        await clearComposer(page);
        const headedResult = await micFlow();
        if (headedResult.ok) {
          return { detail: `[fallback headed] ${headedResult.detail}` };
        }
        return { ok: false, detail: `headless: ${result.detail} | headed: ${headedResult.detail}` };
      }
      return result;
    });

    // Auto-leitura (toggle)
    await runCase(reporter, 'tts-auto-toggle', 'toggle de auto-leitura', async () => {
      const before = await page.evaluate(() => ({
        on: document.querySelector('[data-voice-tts-auto]')?.getAttribute('data-on'),
        pressed: document.querySelector('[data-voice-tts-auto]')?.getAttribute('aria-pressed'),
        prefs: (() => { try { return localStorage.getItem('dsh-tts.prefs'); } catch { return null; } })(),
      }));
      await page.click('[data-voice-tts-auto]');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await page.evaluate(() => ({
        on: document.querySelector('[data-voice-tts-auto]')?.getAttribute('data-on'),
        pressed: document.querySelector('[data-voice-tts-auto]')?.getAttribute('aria-pressed'),
        prefs: (() => { try { return localStorage.getItem('dsh-tts.prefs'); } catch { return null; } })(),
      }));
      const changed = before.on !== after.on || before.pressed !== after.pressed;
      limitations.push('Playback de áudio em headless não é audível; síntese validada via RPC e toggle validado por estado/prefs.');
      return changed
        ? { detail: `antes=${JSON.stringify(before)} depois=${JSON.stringify(after)}` }
        : { ok: false, detail: `estado não mudou: ${JSON.stringify(after)}` };
    });

    // Hot apply: reinstalar os dois pacotes e recarregar a página
    if (options.hotApply) {
      await runCase(reporter, 'hot-apply', 'hot-apply: reinstalar plugin já instalado + reload', async () => {
        // Portátil: --dsh-cli/DSH_CLI -> PATH -> npm global -> app Desktop.
        const dshCli = resolveDshCli(options.dshCli);
        if (!dshCli) {
          return { status: 'skip', detail: `hot-apply precisa do CLI dsh: ${dshHelp().join('; ')}` };
        }
        const runCli = (args) => {
          const execOptions = { timeout: 180000, windowsHide: true };
          if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(dshCli)) {
            // cmd.exe /c "<dsh.cmd>" ... — argumentos separados para não escapar aspas.
            return execFileAsync('cmd.exe', ['/d', '/c', dshCli, ...args], execOptions);
          }
          return execFileAsync(dshCli, args, execOptions);
        };
        const packages = ['dsh-whisper-stt', 'dsh-tts'];
        const outputs = [];
        for (const packageName of packages) {
          const packageDir = path.join(PACKAGES_DIR, packageName);
          const result = await runCli(['plugin', '--profile', options.profile, 'add', '-w', packageDir]);
          outputs.push({ packageName, exitCode: 0, stdout: tail(result.stdout, 500) });
        }
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await dismissPreviewDialog(page);
        await waitForDebugHooks(page, 90000);
        await screenshot('e2e-hot-apply');
        return { detail: `reinstalados: ${outputs.map((entry) => entry.packageName).join(', ')}; reload ok; hooks presentes` };
      });
    }

    // Erros acumulados
    await runCase(reporter, 'console-errors', 'sem console.error/pageerror inesperados', async () => {
      const errors = filterConsoleErrors(consoleMessages);
      const unexpectedPageErrors = pageErrors.filter((text) => !/ResizeObserver loop/i.test(text));
      const fatal = errors.map((entry) => entry.text);
      meta.consoleErrors = fatal;
      if (fatal.length === 0 && unexpectedPageErrors.length === 0) {
        return { detail: `0 console.error não esperados, 0 pageerror (erro de conta conhecido ignorado quando presente)` };
      }
      return { ok: false, detail: `console: ${fatal.slice(0, 10).join(' | ')}; pageerror: ${unexpectedPageErrors.slice(0, 10).join(' | ')}` };
    });
    await runCase(reporter, 'network-failures', 'sem requisições falhas relevantes', async () => {
      const failures = filterNetworkFailures(networkEntries);
      meta.networkFailures = failures;
      if (failures.length === 0) {
        return { detail: `${networkEntries.length} entrada(s) 4xx/requestfailed, 0 relevante(s)` };
      }
      return { ok: false, detail: failures.slice(0, 10).map((entry) => `${entry.url} :: ${entry.reason}`).join(' | ') };
    });

    await screenshot('e2e-final');
  } finally {
    meta.durationMs = Date.now() - startedAt.getTime();
    meta.pageErrors = pageErrors.filter((text) => !/ResizeObserver loop/i.test(text));
    if (meta.consoleErrors.length === 0) meta.consoleErrors = filterConsoleErrors(consoleMessages).map((entry) => entry.text);
    if (meta.networkFailures.length === 0) meta.networkFailures = filterNetworkFailures(networkEntries);
    if (browser) {
      try {
        await browser.close();
      } catch { /* cleanup garantido */ }
    }
    const markdownFile = writeMarkdownReport(reporter, meta);
    reporter.summaryExtra = meta;
    const ok = reporter.print({ strict: options.strict });
    reporter.write();
    console.log(`e2e: relatório markdown em ${markdownFile}`);
    console.log(`e2e: screenshot(s): ${screenshots.map((file) => path.basename(file)).join(', ') || 'nenhum'}`);
    process.exit(ok ? 0 : 1);
  }
}

main().catch((error) => {
  console.error('e2e: erro fatal:', error);
  process.exit(1);
});

