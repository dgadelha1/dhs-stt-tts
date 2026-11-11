/**
 * Descoberta portátil de executáveis usados pelos testes E2E:
 *
 *  - Chrome/Edge para Puppeteer-core:
 *      --chrome / CHROME_PATH / PUPPETEER_EXECUTABLE_PATH / CHROME_BIN
 *      -> candidatos padrão por SO (Windows, Linux, macOS) -> busca no PATH.
 *
 *  - CLI `dsh` (necessário apenas para o teste de hot-apply do E2E):
 *      --dsh-cli / DSH_CLI -> `dsh` no PATH -> npm global -> app Desktop
 *      (raízes de instalação por env: Program Files, LOCALAPPDATA, DSH_APP_ROOT).
 *
 * Nenhum caminho absoluto específico de máquina/usuário é hardcoded.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function isFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function searchPath(names) {
  const results = [];
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) results.push(candidate);
    }
  }
  return results;
}

/** Devolve o caminho do Chrome (ou Edge como fallback) ou null. */
export function resolveChrome(explicit) {
  const env = process.env;
  const candidates = [];
  for (const value of [explicit, env.CHROME_PATH, env.PUPPETEER_EXECUTABLE_PATH, env.CHROME_BIN]) {
    if (value && value.trim()) candidates.push(value.trim());
  }

  if (process.platform === 'win32') {
    const pf = env.ProgramFiles;
    const pf86 = env['ProgramFiles(x86)'];
    const local = env.LOCALAPPDATA;
    const programDirs = [pf, pf86, local ? path.join(local, 'Programs') : null].filter(Boolean);
    for (const base of programDirs) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    if (local) {
      candidates.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    candidates.push(...searchPath(['chrome.exe', 'msedge.exe']));
  } else if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
    }
    candidates.push(...searchPath(['google-chrome', 'chromium', 'microsoft-edge']));
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
    );
    candidates.push(...searchPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']));
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export function chromeHelp() {
  return [
    'defina CHROME_PATH=/caminho/do/chrome (ou PUPPETEER_EXECUTABLE_PATH)',
    'ou passe --chrome <caminho>',
    process.platform === 'win32'
      ? 'candidatos padrão: Program Files/LOCALAPPDATA\\Google\\Chrome e Microsoft Edge'
      : process.platform === 'darwin'
        ? 'candidatos padrão: /Applications/Google Chrome.app, Chromium, Edge'
        : 'candidatos padrão: /usr/bin/google-chrome, chromium, microsoft-edge',
  ];
}

/** Devolve o caminho do CLI dsh ou null (usado apenas no hot-apply do E2E). */
export function resolveDshCli(explicit) {
  const env = process.env;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (env.DSH_CLI) candidates.push(env.DSH_CLI);

  candidates.push(...searchPath(process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']));

  if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'dsh.cmd'));
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'npm', 'dsh.cmd'));
  if (env.HOME) candidates.push(path.join(env.HOME, 'AppData', 'Roaming', 'npm', 'dsh.cmd'));

  const appRoots = [];
  for (const root of [env.DSH_APP_ROOT, env.ProgramFiles && path.join(env.ProgramFiles, 'DeepSeek Harness'), env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'DeepSeek Harness'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')]) {
    if (root) appRoots.push(root);
  }
  if (process.platform !== 'win32') {
    appRoots.push('/Applications/DeepSeek Harness.app/Contents/Resources', '/opt/DeepSeek Harness', '/opt/deepseek-harness');
  }
  for (const root of appRoots) {
    candidates.push(path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    candidates.push(path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh'));
    candidates.push(path.join(root, 'dsh.cmd'));
    candidates.push(path.join(root, 'dsh'));
  }
  if (process.platform === 'win32') {
    // Varre raízes de disco conhecidas (sem hardcodear letra) atrás do app Desktop.
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
      const appRoot = `${letter.toUpperCase()}:\\DeepSeek Harness`;
      candidates.push(path.join(appRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export function dshHelp() {
  return [
    'defina DSH_CLI=/caminho/do/dsh',
    'ou coloque `dsh` no PATH',
    'ou passe --dsh-cli <caminho> ao tests/e2e.mjs',
  ];
}
