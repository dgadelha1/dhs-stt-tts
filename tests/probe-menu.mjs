#!/usr/bin/env node
/** tests/probe-menu.mjs — abre o menu da conta e procura a entrada de Configurações. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { ARTIFACTS_DIR } from './lib/util.mjs';
import { chromeHelp, resolveChrome } from './lib/chrome.mjs';

const stateFile = path.join(ARTIFACTS_DIR, 'dev-server.json');
const url = JSON.parse(fs.readFileSync(stateFile, 'utf8')).url;
const chrome = resolveChrome();
if (!chrome) {
  console.error('probe-menu: Chrome/Edge não encontrado.');
  for (const hint of chromeHelp()) console.error('  - ' + hint);
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900', '--lang=pt-BR'],
  defaultViewport: { width: 1440, height: 900 },
});
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(6000);
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    const buttons = dialog ? [...dialog.querySelectorAll('button')] : [];
    (buttons.find((button) => /continuar|entendi|ok/i.test(button.innerText ?? '')) ?? buttons.at(-1))?.click();
  });
  await sleep(1200);
  const result = {};
  result.accountClick = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Menu da conta"]');
    if (!button) return null;
    button.click();
    return button.outerHTML.slice(0, 300);
  });
  await sleep(1200);
  result.afterAccount = await page.evaluate(() => ({
    menus: [...document.querySelectorAll('[role="menu"], [role="dialog"]')].map((element) => ({
      role: element.getAttribute('role'),
      label: element.getAttribute('aria-label'),
      text: (element.innerText ?? '').slice(0, 800),
    })),
    items: [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="button"]')].map((item) => ({
      text: (item.innerText ?? '').trim().slice(0, 80),
      label: item.getAttribute('aria-label'),
    })),
    buttons: [...document.querySelectorAll('button')].map((button) => ({
      label: button.getAttribute('aria-label'),
      text: (button.innerText ?? '').trim().slice(0, 60),
    })).slice(0, 80),
  }));
  // tenta abrir settings pelo item de menu
  result.settingsClick = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="button"], button')];
    const target = candidates.find((element) => /configura|settings|ajustes|prefer/i.test(`${element.innerText ?? ''} ${element.getAttribute('aria-label') ?? ''}`));
    if (!target) return null;
    target.click();
    return (target.innerText ?? '').trim().slice(0, 80);
  });
  await sleep(2500);
  result.afterSettingsClick = await page.evaluate(() => ({
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((dialog) => ({
      label: dialog.getAttribute('aria-label'),
      text: (dialog.innerText ?? '').slice(0, 1500),
    })),
    settingsSections: document.querySelectorAll('[data-slot="settings.section"]').length,
    sttSettings: document.querySelectorAll('[data-voice-stt-settings]').length,
    ttsSettings: document.querySelectorAll('[data-voice-tts-settings]').length,
    sttText: (document.querySelector('[data-voice-stt-settings]')?.innerText ?? '').slice(0, 500),
    ttsText: (document.querySelector('[data-voice-tts-settings]')?.innerText ?? '').slice(0, 500),
    navItems: [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="tab"], [role="dialog"] nav *')]
      .map((element) => (element.innerText ?? '').trim())
      .filter((text) => text && text.length < 80)
      .slice(0, 60),
  }));
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'probe-menu.png') });
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'probe-menu.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}

