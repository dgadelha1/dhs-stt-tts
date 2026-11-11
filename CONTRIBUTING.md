# Contribuindo · Contributing

Obrigado pelo interesse! Este repositório mantém **dois plugins independentes** para o
DeepSeek Harness: `packages/dsh-whisper-stt` e `packages/dsh-tts`.

> **Idiomas suportados pelo produto: pt‑BR e en‑US.** Contribuições que adicionem um terceiro
> idioma precisam incluir vozes/ASR equivalentes, i18n da UI e testes; abra uma issue antes.

## Estrutura

```
packages/dsh-whisper-stt/   # servidor Cordis + bundle cliente + worker Python
packages/dsh-tts/           # servidor Cordis + bundle cliente + worker/SAPI
scripts/                    # setup-runtime, install, dev-server, sync
tests/                      # smoke cliente, testes de servidor, fixtures, E2E
docs/                       # idiomas + screenshots
```

Cada pacote tem **duas metades**:
- `src/index.js` → plugin Cordis (servidor, RPC). Roda no processo do DSH.
- `src/client.js` → bundle `window.__ModuleLoader__.load({id, factory})` (sem build), servido
  como módulo pelo DSH. Só pode depender de `react`.
- `runtime/` → workers Python/scripts auxiliares.
- `lib/` → **cópia gerada** de `src/` (é o que roda). **Nunca edite `lib/` à mão.**

## Fluxo de desenvolvimento

```powershell
# 1) sincronizar src -> lib
node scripts\sync.mjs

# 2) checks rápidos
node scripts\sync.mjs --check
node --check packages\dsh-whisper-stt\src\client.js
node --check packages\dsh-tts\src\client.js

# 3) testes automatizados (sem browser)
node tests\smoke-client.mjs
node tests\server.mjs

# 4) GUI de teste isolada (profile voice-dev, porta 3099)
pwsh -File scripts\dev-server.ps1
node tests\e2e.mjs            # E2E real com Chrome (requer o dev-server acima e o runtime)

# 5) pipeline completo
pwsh -File tests\run-all.ps1
```

Regras:
- `lib/` e `src/` devem ficar idênticos (`sync --check` é gate no CI e no `prepack`).
- Mudanças de UI: i18n **pt e en** obrigatório; CSS **somente tokens `--dsw-*`** (sem hex/rgb).
- Slots do DSH: não substitua renders nativos; use `ctx.slots.register` com `id` e `order`.
- RPC: erros apenas `bad-request` / `internal`; nunca aceite caminhos de arquivo do cliente.
- Componentes de slot devem ser defensivos (props ausentes → render nulo, sem exceção).
- Sincronize `README.md`/`INSTALL.md`/`docs/LANGUAGES.md` quando o comportamento mudar.

## Commit e PR

- Commits pequenos, mensagem no imperativo (`fix: …`, `feat: …`, `docs: …`).
- PR deve descrever: motivação, mudanças, testes executados (cole a saída) e riscos.
- Rode `pwsh -File tests\run-all.ps1` (ou ao menos sync/check/smoke/server) antes de abrir o PR.
- Alterações que precisem de rede/GPU tornam‑se SKIP documentado quando indisponíveis.

## Segurança

- Não inclua áudio/transcrições/credenciais em logs, fixtures ou issues.
- O áudio do STT não sai da máquina; o TTS neural envia texto à Microsoft (documentado).
- Vulnerabilidades: abra uma issue privada (GitHub Security) em vez de um PR público.

## Licença

Ao contribuir, você concorda em licenciar sua contribuição sob a **MIT** deste repositório.
