#!/usr/bin/env node
/**
 * tests/check-syntax.mjs — `node --check` portátil em todos os arquivos JS do repo.
 *
 * Usado pelo CI (ubuntu/windows) e pelo tests/run-all.ps1. Não depende de globs
 * do shell: enumera os arquivos no próprio Node, então funciona igual em
 * PowerShell, bash e cmd.
 *
 * Uso: node tests/check-syntax.mjs [--quiet]
 * Exit: 0 = todos válidos; 1 = pelo menos um erro de sintaxe.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/util.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'artifacts', 'dist', 'coverage']);

function listJsFiles() {
  const files = [];
  const addFromGlobDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) files.push(path.join(dir, entry.name));
    }
  };

  // packages/<pkg>/{src,lib}/*.js
  const packagesDir = path.join(ROOT, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const pkg of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory() || SKIP_DIRS.has(pkg.name)) continue;
      for (const sub of ['src', 'lib']) addFromGlobDir(path.join(packagesDir, pkg.name, sub));
    }
  }
  // scripts/**, tests/** (recursivo, exceto node_modules/artifacts)
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, 'scripts'));
  walk(path.join(ROOT, 'tests'));
  return [...new Set(files)].sort();
}

function main() {
  const quiet = process.argv.includes('--quiet');
  const files = listJsFiles();
  if (files.length === 0) {
    console.error('check-syntax: nenhum arquivo .js/.mjs encontrado');
    process.exit(1);
  }
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60000 });
    if (result.error) {
      failures.push({ file, detail: result.error.message });
    } else if (result.status !== 0) {
      failures.push({ file, detail: (result.stderr || result.stdout || `exit ${result.status}`).trim() });
    }
  }
  if (!quiet) {
    for (const failure of failures) {
      console.error(`[FAIL] ${path.relative(ROOT, failure.file)}`);
      for (const line of failure.detail.split(/\r?\n/).slice(0, 12)) console.error(`       ${line}`);
    }
  }
  const valid = files.length - failures.length;
  console.log(`check-syntax: ${valid}/${files.length} arquivo(s) com sintaxe válida${failures.length ? `, ${failures.length} com erro` : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
