#!/usr/bin/env node
/**
 * tests/probe-settings.mjs — diagnóstico de como abrir Settings no DSH 0.2.2-rc.1.
 * Não faz parte do pipeline; usado para achar o seletor estável do E2E.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { ARTIFACTS_DIR } from './lib/util.mjs';
import { chromeHelp, resolveChrome } from './lib/chrome.mjs';

const stateFile = path.join(ARTIFACTS_DIR, 'dev-server.json');
const url = JSON.parse(fs.readFileSync(stateFile, 'utf8')).url;
const chrome = resolveChrome();
if (!chrome) {
  console.error('probe-settings: Chrome/Edge não encontrado.');
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(6000);
  const dump = (label) => page.evaluate((tag) => {
    const slots = [...document.querySelectorAll('[data-slot]')].map((element) => element.getAttribute('data-slot'));
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((dialog) => ({
      label: dialog.getAttribute('aria-label'),
      text: (dialog.innerText ?? '').slice(0, 400),
    }));
    const menuItems = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')]
      .map((item) => ({ text: (item.innerText ?? '').trim().slice(0, 80), attrs: [...item.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`) }));
    const buttons = [...document.querySelectorAll('button')].map((button) => ({
      label: button.getAttribute('aria-label') ?? button.innerText?.trim().slice(0, 60) ?? '',
      attrs: [...button.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`),
    }));
    return {
      tag,
      slots: [...new Set(slots)],
      dialogs,
      menuItems,
      buttons: buttons.slice(0, 60),
      settingsSections: document.querySelectorAll('[data-slot="settings.section"]').length,
      sttSettings: document.querySelectorAll('[data-voice-stt-settings]').length,
      ttsSettings: document.querySelectorAll('[data-voice-tts-settings]').length,
      bodyHead: (document.body?.innerText ?? '').slice(0, 300),
    };
  }, label);

  const report = {};
  // 1) fechar aviso de visualização
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    const buttons = dialog ? [...dialog.querySelectorAll('button')] : [];
    const target = buttons.find((button) => /continuar|entendi|ok|fechar/i.test(button.innerText ?? '')) ?? buttons.at(-1);
    target?.click();
  });
  await sleep(1500);
  report.initial = await dump('initial');

  // 2) abrir menu "Mais" e listar itens
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.getAttribute('aria-label') ?? '').trim() === 'Mais');
    button?.click();
  });
  await sleep(1200);
  report.afterMore = await dump('afterMore');

  // 3) clicar em item de menu com settings/configura
  const clicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="button"], button')];
    const target = items.find((item) => /configura|settings|ajustes|prefer/i.test(`${item.innerText ?? ''} ${item.getAttribute('aria-label') ?? ''}`));
    if (!target) return null;
    target.click();
    return (target.innerText ?? '').trim().slice(0, 80);
  });
  await sleep(2500);
  report.afterMenuClick = await dump('afterMenuClick');
  report.clickedMenuItem = clicked;

  // 4) atalho ctrl+, no body
  if (report.afterMenuClick.settingsSections === 0) {
    await page.keyboard.down('Control');
    await page.keyboard.press(',');
    await page.keyboard.up('Control');
    await sleep(2000);
    report.afterShortcut = await dump('afterShortcut');
  }
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'probe-settings-2.png') });
  report.errors = errors;
  const out = path.join(ARTIFACTS_DIR, 'probe-settings.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    clickedMenuItem: report.clickedMenuItem,
    initialSlots: report.initial.slots,
    afterMoreMenuItems: report.afterMore.menuItems,
    afterMenuClick: {
      slots: report.afterMenuClick.slots,
      dialogs: report.afterMenuClick.dialogs,
      settingsSections: report.afterMenuClick.settingsSections,
      stt: report.afterMenuClick.sttSettings,
      tts: report.afterMenuClick.ttsSettings,
    },
    afterShortcut: report.afterShortcut ? {
      dialogs: report.afterShortcut.dialogs,
      settingsSections: report.afterShortcut.settingsSections,
      stt: report.afterShortcut.sttSettings,
      tts: report.afterShortcut.ttsSettings,
    } : null,
    errors,
    out,
  }, null, 2));
} finally {
  await browser.close();
}

