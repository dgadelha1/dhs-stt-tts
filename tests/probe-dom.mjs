#!/usr/bin/env node
/**
 * tests/probe-dom.mjs — ferramenta de diagnóstico (não é parte do pipeline).
 * Abre o dev server 3099 com o token do state file e imprime a estrutura da UI
 * relevante para o E2E: hooks de debug, botões com data-* e aria-label, como abrir
 * Settings e o HTML do composer.
 *
 * Uso: node tests/probe-dom.mjs [--url <url>] [--headed] [--out <arquivo>]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { ARTIFACTS_DIR } from './lib/util.mjs';
import { chromeHelp, resolveChrome } from './lib/chrome.mjs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const stateFile = path.join(ARTIFACTS_DIR, 'dev-server.json');
let url = argValue('--url');
if (!url && fs.existsSync(stateFile)) url = JSON.parse(fs.readFileSync(stateFile, 'utf8')).url;
if (!url) {
  console.error('probe-dom: sem URL (state file ausente); passe --url');
  process.exit(2);
}
const headed = args.includes('--headed');
const outFile = argValue('--out') ?? path.join(ARTIFACTS_DIR, 'probe-dom.json');
const chrome = resolveChrome(argValue('--chrome'));
if (!chrome) {
  console.error('probe-dom: Chrome/Edge não encontrado.');
  for (const hint of chromeHelp()) console.error('  - ' + hint);
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: headed ? false : 'new',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=pt-BR',
  ],
  defaultViewport: { width: 1440, height: 900 },
});
try {
  const page = await browser.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const info = await page.evaluate(() => {
    const describe = (element) => {
      if (!element) return null;
      const attrs = {};
      for (const attr of element.attributes ?? []) {
        if (attr.name === 'class' || attr.name === 'style') continue;
        attrs[attr.name] = attr.value?.slice?.(0, 120) ?? attr.value;
      }
      return {
        tag: element.tagName?.toLowerCase(),
        text: (element.innerText ?? element.textContent ?? '').trim().slice(0, 120),
        ariaLabel: element.getAttribute?.('aria-label'),
        title: element.getAttribute?.('title'),
        attrs,
      };
    };
    const all = [...document.querySelectorAll('body *')];
    const withData = all.filter((element) => [...element.attributes].some((attr) => attr.name.startsWith('data-'))).slice(0, 120);
    const buttons = [...document.querySelectorAll('button,[role="button"]')].slice(0, 120);
    const settingsCandidates = all
      .filter((element) => /settings|configura|prefer[êe]ncias|ajustes/i.test(
        `${element.getAttribute?.('aria-label') ?? ''} ${element.getAttribute?.('title') ?? ''} ${element.innerText ?? ''}`,
      ) && element.querySelectorAll('*').length < 20)
      .slice(0, 40);
    const composer = document.querySelector('textarea, [contenteditable="true"]');
    const composerAncestor = composer?.closest('form') ?? composer?.parentElement?.parentElement ?? composer?.parentElement;
    return {
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText?.length ?? 0,
      bodyTextHead: (document.body?.innerText ?? '').slice(0, 500),
      hooks: {
        debug: Boolean(window.__dshVoiceDebug),
        stt: Boolean(window.__dshVoiceDebug?.stt),
        tts: Boolean(window.__dshVoiceDebug?.tts),
        sttRpc: typeof window.__dshVoiceDebug?.stt?.rpc,
        ttsRpc: typeof window.__dshVoiceDebug?.tts?.rpc,
      },
      bootKeys: Object.keys(window.__DSH_BOOT__ ?? {}),
      counts: {
        dataVoiceSttButton: document.querySelectorAll('[data-voice-stt-button]').length,
        dataVoiceTtsButton: document.querySelectorAll('[data-voice-tts-button]').length,
        dataVoiceTtsAuto: document.querySelectorAll('[data-voice-tts-auto]').length,
        dataVoiceSttSettings: document.querySelectorAll('[data-voice-stt-settings]').length,
        dataVoiceTtsSettings: document.querySelectorAll('[data-voice-tts-settings]').length,
        textareas: document.querySelectorAll('textarea').length,
        contenteditables: document.querySelectorAll('[contenteditable="true"]').length,
        buttons: buttons.length,
      },
      slotContainers: [...new Set(all
        .map((element) => element.getAttribute?.('data-slot'))
        .filter(Boolean))].slice(0, 80),
      dataElements: withData.map(describe),
      buttons: buttons.map(describe),
      settingsCandidates: settingsCandidates.map(describe),
      composerHtml: (composerAncestor?.outerHTML ?? '').slice(0, 3000),
      composerFound: describe(composer),
      sidebarText: (document.querySelector('aside,nav')?.innerText ?? '').slice(0, 800),
    };
  });
  const interactive = { dismissedPreview: false, slots: {}, settings: {}, errors: [] };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    interactive.dismissedPreview = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!dialog) return false;
      const buttons = [...dialog.querySelectorAll('button')];
      const target = buttons.find((button) => /continuar|entendi|ok|fechar/i.test(button.innerText ?? '')) ?? buttons[buttons.length - 1];
      if (!target) return false;
      target.click();
      return true;
    });
    await sleep(1500);
    interactive.slots = await page.evaluate(() => {
      const names = [
        'sidebar.settings', 'settings.launcher', 'conversation.input.left',
        'conversation.input.activity', 'conversation.composer.bar', 'conversation.input.overlay',
      ];
      const out = {};
      for (const name of names) {
        const element = document.querySelector(`[data-slot="${name}"]`);
        out[name] = element
          ? { html: element.innerHTML.slice(0, 3000), text: (element.innerText ?? '').slice(0, 300) }
          : null;
      }
      return out;
    });
    interactive.settingsClickTarget = await page.evaluate(() => {
      for (const selector of [
        '[data-slot="settings.launcher"] button',
        '[data-slot="sidebar.settings"] button',
        '[data-slot="settings.launcher"]',
        '[data-slot="sidebar.settings"]',
      ]) {
        const element = document.querySelector(selector);
        if (element) {
          element.click();
          return selector;
        }
      }
      return null;
    });
    await sleep(2500);
    interactive.settings = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      const dialog = dialogs.find((candidate) => /configura|settings|ajustes/i.test(candidate.innerText ?? ''));
      return {
        dialogCount: dialogs.length,
        dialogText: (dialog?.innerText ?? '').slice(0, 2000),
        settingsSectionSlotCount: document.querySelectorAll('[data-slot="settings.section"]').length,
        counts: {
          stt: document.querySelectorAll('[data-voice-stt-settings]').length,
          tts: document.querySelectorAll('[data-voice-tts-settings]').length,
        },
        sttSettings: document.querySelector('[data-voice-stt-settings]')?.innerText?.slice(0, 800) ?? null,
        ttsSettings: document.querySelector('[data-voice-tts-settings]')?.innerText?.slice(0, 800) ?? null,
        navItems: [...document.querySelectorAll('[data-slot="settings.section"] button, [role="tablist"] button, [role="dialog"] nav button')]
          .map((button) => (button.innerText ?? '').trim())
          .filter(Boolean)
          .slice(0, 40),
      };
    });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'probe-settings.png') });
  } catch (error) {
    interactive.errors.push(String(error));
  }

  const result = { url: url.replace(/token=[^&]+/, 'token=***'), consoleMessages, pageErrors, info, interactive };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    hooks: info.hooks,
    counts: info.counts,
    slotContainers: info.slotContainers,
    settingsCandidates: info.settingsCandidates,
    buttons: info.buttons.slice(0, 40),
    composerFound: info.composerFound,
    bodyTextHead: info.bodyTextHead,
    pageErrors,
    consoleErrors: consoleMessages.filter((message) => message.type === 'error').slice(0, 20),
    outFile,
  }, null, 2));
} finally {
  await browser.close();
}

