# Testes — DSH Voice Suite

Harness de QA dos plugins `dsh-whisper-stt` e `dsh-tts`. O CI roda em Linux e
Windows apenas a parte **pura** (sintaxe + smoke cliente + servidor RPC); o E2E
de navegador, o setup de runtime e os scripts de instalação são locais.

## Estrutura

```
tests/
├── check-syntax.mjs    # node --check portátil (usado no CI e no run-all)
├── smoke-client.mjs    # bundles cliente sem browser (vm + react-dom/server)
├── server.mjs          # RPC dos dois servidores com ctx Cordis falso
├── e2e.mjs             # E2E real: Chrome + profile de teste (local)
├── run-all.ps1         # pipeline completo local (Windows/PowerShell 7)
├── fixtures/           # WAVs 16 kHz mono PCM16 (pt/en) + texts.json + gerador SAPI
├── lib/                # utilidades, DOM mínimo, ctx falsos, descoberta portátil
└── artifacts/          # relatórios/screenshots gerados (gitignored)
```

## Pré-requisitos

- **Node.js 20+** (CI usa 22). `npm install` dentro de `tests/` instala
  `react`, `react-dom` e `puppeteer-core` (sem baixar Chrome).
- **Linux/macOS**: smoke + server + sintaxe funcionam sem nada extra.
- **E2E** (local): Chrome/Chromium/Edge instalado **e** um profile DSH de teste
  com os dois plugins instalados, servido pelo `scripts/dev-server.ps1`
  (Windows) ou por `dsh --profile <profile> --port <porta> --no-open`.
- **Runtime Python** (só E2E de transcrição/síntese): `scripts/setup-runtime.ps1`
  (Windows) ou `scripts/setup-runtime.sh` (POSIX). Sem ele, o E2E valida o
  caminho de erro acionável (`--expect-missing`).

## Comandos rápidos

```bash
cd tests
npm ci                       # ou npm install

node check-syntax.mjs        # node --check em packages/scripts/tests
node smoke-client.mjs        # 46 asserts de contrato do cliente
node server.mjs              # 61 asserts de contrato do servidor
```

Saída: relatórios JSON em `tests/artifacts/` (`smoke-client-report.json`,
`server-report.json`). Exit code ≠ 0 em falha.

## E2E (local, precisa de browser + profile)

```powershell
# 1) subir o servidor de teste (imprime a URL com token)
pwsh -File scripts/dev-server.ps1 -Profile voice-dev -Port 3099

# 2) rodar o E2E (Chrome é descoberto sozinho; veja variáveis abaixo)
node tests/e2e.mjs --profile voice-dev

# 3) E2E do caminho "runtime ausente" (home temporário vazio)
pwsh -File scripts/dev-server.ps1 -Stop
pwsh -File scripts/dev-server.ps1 -VoiceHome C:\temp\voice-home-vazio
node tests/e2e.mjs --expect-missing --artifacts-suffix missing
pwsh -File scripts/dev-server.ps1 -Stop
```

O E2E grava `tests/artifacts/e2e-report.{md,json}` e screenshots
(`e2e-boot.png`, `e2e-settings-stt.png`, `e2e-mic-done.png`, ...). Por padrão é
headless; se o fluxo real de microfone (fake capture de `fixtures/pt-br.wav`)
falhar em headless, o próprio E2E tenta de novo em modo **headed**.

Opções úteis: `--url <url-com-token>`, `--headed`, `--hot-apply`,
`--expect-missing`, `--strict`, `--chrome <caminho>`, `--dsh-cli <caminho>`.

## Pipeline completo local (Windows)

```powershell
pwsh -File tests/run-all.ps1            # sintaxe, sync, smoke, server, setup-check, dev-server, e2e
pwsh -File tests/run-all.ps1 -SkipE2E   # só as suítes puras + setup-check
pwsh -File tests/run-all.ps1 -HotApply  # inclui reinstalação hot-apply no E2E
```

Relatórios: `tests/artifacts/run-all-summary.json` e logs por passo.

## Variáveis de ambiente (portabilidade)

| Variável | Uso |
|---|---|
| `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | caminho do Chrome para o E2E (senão descobre por SO/PATH) |
| `DSH_CLI` | caminho do CLI `dsh` (senão PATH → npm global → app Desktop) |
| `E2E_URL` | URL do servidor de teste (senão lê `artifacts/dev-server.json`) |
| `DSH_VOICE_HOME` | home do runtime Python (default `~/.dsh/dsh-voice`) |
| `DSH_VOICE_PYTHON` | Python base para os venvs (senão 3.12/3.11/3.10) |
| `DSH_HOME` | home do DSH (default `~/.dsh`) |

## O que é Windows-only

- **SAPI** (`System.Speech` via PowerShell) é o fallback offline do TTS: no CI
  Linux os casos SAPI do `server.mjs` são **SKIP**, nunca FAIL.
- `tests/run-all.ps1`, `scripts/*.ps1`, `install.bat` e o `dev-server` usam
  PowerShell 7 (Windows); em Linux/macOS use `node` diretamente e o
  `setup-runtime.sh`/`install.sh`.
- O E2E de microfone depende de Chrome com fake audio capture e de um profile
  DSH real.
- `edge-tts` exige rede; no CI não é executado (síntese real é local).

## Validação em Linux (WSL Ubuntu)

O harness puro foi validado em Ubuntu (Node 22 portátil, sem depender de
Windows): `sync --check`, `check-syntax` (20/20), `smoke-client` (46 pass) e
`server` (59 pass, 0 fail, 4 skip — SAPI/edge indisponíveis viram SKIP). O
`setup-runtime.sh --check` também roda em Ubuntu (encontra `python3.12` e
reporta os venvs ausentes).

## Portabilidade

Nenhum caminho absoluto de máquina/usuário é assumido. A raiz do repositório é
derivada de `import.meta.url`; Chrome e `dsh` têm descoberta por env → PATH →
candidatos padrão do SO; os WAVs são lidos relativos a `tests/fixtures`.
