#!/usr/bin/env node
/**
 * scripts/sync.mjs — espelha `packages/<pkg>/src/**` em `packages/<pkg>/lib/**`.
 *
 * O `lib/` é o que roda de fato (package.json `main`/`exports`). O `src/` é a
 * fonte editável. Este script mantém os dois idênticos e é usado no `prepack`
 * dos pacotes.
 *
 * Uso:
 *   node scripts/sync.mjs                      # sincroniza todos os pacotes
 *   node scripts/sync.mjs --check              # só verifica (exit 1 se divergir)
 *   node scripts/sync.mjs --package dsh-tts    # restringe a um pacote (repetível)
 *   node scripts/sync.mjs --json               # resumo legível por máquina
 *   node scripts/sync.mjs --root <dir>         # raiz do repositório
 *   node scripts/sync.mjs --help
 *
 * Códigos de saída:
 *   0 = tudo sincronizado / sem divergências
 *   1 = divergências encontradas (--check) ou falha de I/O
 *   2 = erro de uso
 *
 * Regras:
 *   - Ignora `node_modules`, `.git`, arquivos `.DS_Store` e temporários de sync.
 *   - Cópia atômica (arquivo temporário + rename) para nunca deixar `lib/` meio escrito.
 *   - Remove arquivos órfãos de `lib/` que não existem mais em `src/` (em modo sync).
 *   - Pacote ainda não criado é reportado como "skip" (não é divergência), a menos
 *     que `--require` seja passado (aí falha).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PACKAGES = ['dsh-whisper-stt', 'dsh-tts'];
const IGNORED_NAMES = new Set(['node_modules', '.git', '.DS_Store']);
const TMP_SUFFIX = '.sync-tmp';

const HELP = `sync.mjs — espelha src/ -> lib/ dos plugins

Uso: node scripts/sync.mjs [opções]

Opções:
  --check                Apenas verifica; exit 1 se src e lib divergirem.
  --package <nome>       Restringe a um pacote (pode repetir). Default: ${DEFAULT_PACKAGES.join(', ')}.
  --require              Falha se um pacote esperado não existir.
  --root <dir>           Raiz do repositório (default: diretório pai de scripts/).
  --json                 Imprime um resumo JSON (uma linha) ao final.
  --quiet                Omite o relatório por arquivo; mantém o resumo.
  --verbose              Detalha cada arquivo copiado/divergente.
  -h, --help             Mostra esta ajuda.
`;

function parseArgs(argv) {
  const opts = {
    check: false,
    requirePackages: false,
    json: false,
    quiet: false,
    verbose: false,
    root: undefined,
    packages: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--check':
        opts.check = true;
        break;
      case '--require':
        opts.requirePackages = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--root': {
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) throw new UsageError('--root exige um diretório');
        opts.root = value;
        i += 1;
        break;
      }
      case '--package': {
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) throw new UsageError('--package exige um nome');
        opts.packages.push(value);
        i += 1;
        break;
      }
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new UsageError(`argumento desconhecido: ${arg}`);
    }
  }
  return opts;
}

class UsageError extends Error {}

function defaultRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

function shouldIgnore(name) {
  return IGNORED_NAMES.has(name) || name.endsWith(TMP_SUFFIX);
}

/** Lista recursivamente caminhos relativos (com '/') de arquivos regulares. */
function listFiles(baseDir) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
      // links simbólicos são ignorados de propósito (não seguimos fora do pacote)
    }
  };
  walk(baseDir, '');
  return out;
}

function readIfExists(abs) {
  try {
    return fs.readFileSync(abs);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Compara conjuntos de arquivos e conteúdo; devolve o plano de ação. */
function diffPackage(pkgDir) {
  const srcDir = path.join(pkgDir, 'src');
  const libDir = path.join(pkgDir, 'lib');

  const srcFiles = fs.existsSync(srcDir) ? listFiles(srcDir) : [];
  const libFiles = fs.existsSync(libDir) ? listFiles(libDir) : [];
  const srcSet = new Set(srcFiles);
  const libSet = new Set(libFiles);

  const missing = []; // em src, não em lib
  const changed = []; // nos dois, conteúdo diferente
  const stale = []; // em lib, não em src
  const same = [];

  for (const rel of srcFiles) {
    if (!libSet.has(rel)) {
      missing.push(rel);
      continue;
    }
    const srcBuf = readIfExists(path.join(srcDir, rel));
    const libBuf = readIfExists(path.join(libDir, rel));
    if (srcBuf === null || libBuf === null || !srcBuf.equals(libBuf)) {
      changed.push(rel);
    } else {
      same.push(rel);
    }
  }
  for (const rel of libFiles) {
    if (!srcSet.has(rel)) stale.push(rel);
  }

  return { srcDir, libDir, srcFiles, libFiles, missing, changed, stale, same };
}

function copyFileAtomic(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}${TMP_SUFFIX}`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

function syncPackage(pkgName, root, opts, report) {
  const pkgDir = path.join(root, 'packages', pkgName);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const srcDir = path.join(pkgDir, 'src');

  if (!fs.existsSync(pkgJsonPath) || !fs.existsSync(srcDir)) {
    const reason = !fs.existsSync(pkgJsonPath)
      ? 'package.json ausente (pacote ainda não criado)'
      : 'diretório src/ ausente';
    report.push({
      package: pkgName,
      status: opts.requirePackages ? 'error' : 'skip',
      reason,
      missing: [],
      changed: [],
      stale: [],
      copied: 0,
      removed: 0,
      same: 0,
    });
    return;
  }

  let plan;
  try {
    plan = diffPackage(pkgDir);
  } catch (error) {
    report.push({
      package: pkgName,
      status: 'error',
      reason: `falha ao ler pacote: ${error.message}`,
      missing: [],
      changed: [],
      stale: [],
      copied: 0,
      removed: 0,
      same: 0,
    });
    return;
  }

  const entry = {
    package: pkgName,
    status: 'ok',
    reason: '',
    missing: plan.missing,
    changed: plan.changed,
    stale: plan.stale,
    copied: 0,
    removed: 0,
    same: plan.same.length,
  };

  if (opts.check) {
    if (plan.missing.length || plan.changed.length || plan.stale.length) {
      entry.status = 'diff';
    }
    report.push(entry);
    return;
  }

  try {
    for (const rel of [...plan.missing, ...plan.changed]) {
      copyFileAtomic(path.join(plan.srcDir, rel), path.join(plan.libDir, rel));
      entry.copied += 1;
    }
    for (const rel of plan.stale) {
      fs.rmSync(path.join(plan.libDir, rel), { force: true });
      entry.removed += 1;
      // remove diretórios que ficaram vazios (sem subir acima de lib/)
      let dir = path.dirname(path.join(plan.libDir, rel));
      while (dir.startsWith(plan.libDir) && dir !== plan.libDir) {
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
          else break;
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
    if (entry.copied === 0 && entry.removed === 0) entry.reason = 'já sincronizado';
  } catch (error) {
    entry.status = 'error';
    entry.reason = `falha ao sincronizar: ${error.message}`;
  }
  report.push(entry);
}

function formatEntry(entry, opts) {
  const lines = [];
  const head = entry.package.padEnd(18);
  if (entry.status === 'ok') {
    if (entry.copied === 0 && entry.removed === 0) {
      lines.push(`[ok]   ${head} em sincronia (${entry.same} arquivo(s))`);
    } else {
      lines.push(`[ok]   ${head} ${entry.copied} copiado(s), ${entry.removed} órfão(s) removido(s)`);
    }
  } else if (entry.status === 'diff') {
    lines.push(`[diff] ${head} src/ e lib/ divergem:`);
    for (const rel of entry.missing) lines.push(`         - ausente em lib/: ${rel}`);
    for (const rel of entry.changed) lines.push(`         - diferente: ${rel}`);
    for (const rel of entry.stale) lines.push(`         - órfão em lib/: ${rel}`);
  } else if (entry.status === 'skip') {
    lines.push(`[skip] ${head} ${entry.reason}`);
  } else {
    lines.push(`[erro] ${head} ${entry.reason}`);
  }
  if (opts.verbose && entry.status === 'ok' && (entry.copied || entry.removed)) {
    lines.push('         (use --quiet para omitir)');
  }
  return lines.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`sync: ${error.message}\n`);
      console.error(HELP);
      process.exit(2);
    }
    throw error;
  }
  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  const root = path.resolve(opts.root ?? defaultRoot());
  const packages = opts.packages.length ? opts.packages : DEFAULT_PACKAGES;

  if (!fs.existsSync(path.join(root, 'packages'))) {
    console.error(`sync: diretório de pacotes não encontrado em ${path.join(root, 'packages')}`);
    process.exit(2);
  }

  console.log(`sync: raiz=${root} modo=${opts.check ? 'check' : 'sync'}`);
  const report = [];
  for (const pkg of packages) {
    try {
      syncPackage(pkg, root, opts, report);
    } catch (error) {
      report.push({
        package: pkg,
        status: 'error',
        reason: error.message,
        missing: [],
        changed: [],
        stale: [],
        copied: 0,
        removed: 0,
        same: 0,
      });
    }
  }

  const failures = report.filter((entry) => entry.status === 'diff' || entry.status === 'error');
  const skips = report.filter((entry) => entry.status === 'skip');

  if (!opts.quiet || opts.json) {
    for (const entry of report) console.log(formatEntry(entry, opts));
  } else {
    for (const entry of report) {
      if (entry.status !== 'ok') console.log(formatEntry(entry, opts));
    }
  }

  const summary = {
    ok: failures.length === 0,
    check: opts.check,
    root,
    packages: report,
    failures: failures.length,
    skipped: skips.length,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary));
  } else {
    if (failures.length > 0) {
      const verb = opts.check ? 'divergências encontradas' : 'falhas de sincronização';
      console.error(`sync: ${failures.length} pacote(s) com ${verb}. Rode: node scripts/sync.mjs`);
    } else if (opts.check && skips.length === 0) {
      console.log('sync: ok — src/ e lib/ idênticos.');
    }
  }

  if (failures.length > 0) process.exit(1);
  if (opts.check && skips.length > 0) {
    // --check não falha por pacote ausente; --require sim (vira 'error' acima).
    console.log(`sync: ${skips.length} pacote(s) ignorado(s) por ainda não existirem.`);
  }
  process.exit(0);
}

main();
