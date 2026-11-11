# DSH Voice Suite — Especificação técnica

Status: **v1.0.0** (implementado e validado no DSH 0.2.2-rc.1, Windows 11).
Produto: dois plugins instaláveis no DeepSeek Harness (DSH) — `dsh-whisper-stt` (STT local
com Whisper) e `dsh-tts` (leitura neural com fallbacks) — com UI integrada à GUI web, em
português (BR) e inglês (US).

Documentos relacionados: [README](README.md) · [INSTALL](INSTALL.md) ·
[docs/LANGUAGES.md](docs/LANGUAGES.md).

## 0. Idiomas suportados (pt-BR e en-US)

**Somente dois idiomas são suportados: `pt-BR` e `en-US`.** Isso vale para a transcrição, as
vozes de leitura e a interface dos plugins; a GUI em outro locale cai em inglês.

- **STT:** o payload de `transcribe` aceita `language: "auto" | "pt" | "en"` (sinônimos
  `pt-BR`/`en-US`); qualquer outro valor retorna `bad-request`. Em `auto` o Whisper detecta o
  idioma falado; em `pt`/`en` o idioma é imposto. O cliente envia o idioma do seletor do
  microfone (`localStorage["dsh-whisper-stt.prefs"].language`, default `auto`); o servidor
  persiste um padrão em `config.json` (`language`) usado pelo runtime e pelo teste de microfone.
- **TTS:** `synthesize` aceita `lang: "pt-BR" | "en-US"` (fechado). O cliente resolve o idioma
  por **preferência explícita** (`dsh-tts.prefs.lang`: `auto` | `pt-BR` | `en-US`) ou, em
  `auto`, por **detecção local do texto** (`detectLang`); a voz é escolhida no catálogo do
  idioma resolvido (edge/SAPI).
- A UI dos plugins é publicada em `pt` e `en` (namespace próprio de i18n) e nunca exige o
  idioma do sistema.
- Documentação de usuário: **[docs/LANGUAGES.md](docs/LANGUAGES.md)**.

---

## 1. Objetivos e não-objetivos

**Objetivos**
- Ditado de voz fluido no composer, com transcrição **local** (privacidade) e baixa latência.
- Leitura em voz alta da saída do assistente com **qualidade neural** e operação offline
  possível (fallback).
- Dois pacotes independentes (instalar/remover sem afetar o outro), sem build step no cliente.
- UI/UX profissional: estados claros, acessível, tema claro/escuro, i18n pt/en.

**Não-objetivos (v1)**
- Streaming contínuo de transcrição (parciais em tempo real) — v1 faz push-to-talk com
  transcrição final; o worker já é compatível com uma futura via de parciais.
- Clonagem de voz/síntese on-device (Piper/Kokoro) — planejado como engine adicional.
- Suporte a macOS/Linux — a arquitetura é portável, mas SAPI e a validação são Windows.
- Sincronização/multiusuário: os plugins são locais ao profile do DSH.

---

## 2. Arquitetura

```
┌──────────────────────────────── DSH GUI (browser/Electron renderer) ───────────────────────────────┐
│                                                                                                    │
│  composer                                                                                          │
│  ├── [STT] botão microfone (slot conversation.input.activity, single)                              │
│  │      getUserMedia → MediaRecorder → decodeAudioData → OfflineAudioContext(16 kHz mono)            │
│  │      → WAV PCM16 (base64) → RPC /voice-stt/transcribe → inputActions.insertText(text, span)     │
│  │                                                                                                 │
│  └── [TTS] controles globais (slot conversation.input.left, list)                                  │
│         useChat(sel) → última resposta final → normalização → sentenças → RPC /voice-tts/synthesize │
│         → fila de áudio (HTMLAudioElement + Blob URLs) → fala/para/auto-leitura                     │
│                                                                                                    │
│  chat: [TTS] botão por mensagem (slot conversation.chat.assistant-actions, list) — messageId        │
│                                                                                                    │
│  Settings: seções próprias (slot settings.section, list root) para status/runtime/config            │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                   │ RPC (connection service, fence: loopback+same-origin+cookie)
                                   ▼
┌──────────────────────────────── DSH host (Node, processo do app) ─────────────────────────────────┐
│  dsh-whisper-stt (Cordis)                      dsh-tts (Cordis)                                    │
│  ├── canal /voice-stt                          ├── canal /voice-tts                                 │
│  ├── worker Python persistente (JSON Lines)    ├── worker Python edge-tts (JSON Lines)             │
│  │   faster-whisper (CUDA→CPU)                 ├── engine SAPI (PowerShell System.Speech)           │
│  └── data: ~/.dsh/dsh-voice/stt                └── data: ~/.dsh/dsh-voice/tts (cache LRU)         │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Princípios:
1. **Cliente fino, servidor com privilégios**: captura/playback no browser; processos e
   arquivos no host.
2. **Nenhum caminho de arquivo do cliente**; apenas payloads validados.
3. **Workers persistentes** para carregar modelos uma vez (latência) e encerrar por ociosidade.
4. **Degradação graciosa** em todos os pontos de integração (slots, hooks, engines).

---

## 3. Pacote de plugin (formato DSH)

Cada plugin é um pacote npm com duas metades e um patch Cordis:

```
packages/<nome>/
├── package.json          # name, type=module, main=lib/index.js, exports, dsh.bundle.patch, dsh.client
├── cordis.patch.yml      # - insert: [{ id, name }]
├── src/                  # fonte (editada)
│   ├── index.js          # plugin Cordis (servidor)
│   └── client.js         # bundle __ModuleLoader__ (cliente)
├── lib/                  # cópia de src (usada em runtime)
├── runtime/              # workers Python + requirements + scripts auxiliares
├── README.md
└── LICENSE
```

`package.json` (campos essenciais):

```jsonc
{
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [
      "@deepseek-ai/dsh-client-modules", "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-ui-theme", "@deepseek-ai/dsh-client-locale" ] }
  }
}
```

- O CLI (`dsh plugin add`) instala o pacote no profile, reconcilia
  `dsh.profile.bundles` e o **boot** compõe as camadas.
- Cliente é servido como módulo: `/plugins/??<nome>/client.js` (sem cache) e injetado no
  `__DSH_BOOT__` da página.
- **Sem build step**: o cliente usa apenas `require("react")`; o resto vem dos serviços do
  runtime.

---

## 4. Servidor — canal RPC

### 4.1 Registro e envelope

- Serviço `connection` do DSH; canal sem `/` interno (`/voice-stt`, `/voice-tts`).
- Registro: `ctx.connection.rpc.handle(channel, handler)` com fallback documentado para
  `connection.register(ctx, channel, handler)` quando o serviço não alcança `webServer`
  (mesma fence, mesmo owner).
- Handler: `(endpoint, payload) => RpcResult`.
- Envelope HTTP (cliente): `POST /<canal>/<endpoint>` com
  `{ "type": "client-request", "rpcId": "…", "method": "<endpoint>", "payload": {…} }`
  e resposta `{ "type": "server-response", "rpcId": "…", "result": RpcResult }`.
- **Segurança:** fence do DSH — Host loopback + same-origin (`Origin`/`Sec-Fetch-Site`) +
  **cookie de sessão** do browser; sem cookie → 401.
- `RpcResult` = `{ ok: true, value }` | `{ ok: false, error: { code, message, details } }`;
  códigos usados: **`bad-request`**, **`internal`**.

### 4.2 `/voice-stt` — endpoints

| endpoint | payload | retorno |
|---|---|---|
| `status` | `{}` | `{ ready, python: {found, version}, venv: {present}, deps: {fasterWhisper}, model: {name, present, bytes}, device: {cuda, name, fallback}, languages: ["auto","pt","en"], maxAudioSeconds, maxAudioBytes }` |
| `prepare` | `{ model?, pythonPath? }` | `{ jobId }` — inicia (idempotente) instalação de venv/deps/modelo |
| `prepareStatus` | `{}` | `{ phase: "idle"\|"venv"\|"pip"\|"model"\|"load"\|"ready"\|"failed", progress: 0..1, message, error? }` |
| `transcribe` | `{ audioBase64, language: "auto"\|"pt"\|"en", model? }` | `{ text, language, durationSeconds, inferenceMs }` |
| `cancel` | `{}` | `{ cancelled: boolean }` |
| `setConfig` | `{ model?, device?, language? }` | `{ config }` |

Validação de áudio: WAV RIFF/WAVE, PCM16 mono, 16 kHz, `bytes ≤ 4 MB base64`,
`duração ≤ 60 s` (configurável 30–120; máx. 120). Qualquer desvio → `bad-request`.

### 4.3 `/voice-tts` — endpoints

| endpoint | payload | retorno |
|---|---|---|
| `status` | `{}` | `{ engines: [{id, available, reason?}], voices: { "pt-BR": [...], "en-US": [...] }, defaultEngine, cache: {files, bytes} }` |
| `prepare` | `{}` | `{ jobId }` — instala o venv do `edge-tts` |
| `prepareStatus` | `{}` | `{ phase, progress, message, error? }` |
| `synthesize` | `{ text, lang: "pt-BR"\|"en-US", voice?, rate? 0.5–2, pitch? -20..20, engine?: "auto"\|"edge"\|"sapi" }` | `{ audioBase64, mime, engine, voice, cached }` |
| `voices` | `{}` | `{ "pt-BR": [...], "en-US": [...] }` (força redetect) |
| `cancel` | `{}` | `{ cancelled }` |

Validação: `text` 1–4000 chars (cliente envia ≤1500), `rate`/`pitch` em faixa; senão `bad-request`.
Cache LRU por `sha256(engine|voice|rate|pitch|text)`, limite 50 MB / 300 arquivos.

---

## 5. Workers Python e runtimes

### 5.1 Protocolo (ambos os workers)

JSON Lines em `stdin`/`stdout`; **nada além de JSON em stdout**; diagnósticos em `stderr`
(capturado para `<dataDir>/logs/worker.log`).

```jsonc
// requisição
{ "id": 7, "cmd": "transcribe", "wav_b64": "...", "language": "pt" }
// resposta ok
{ "id": 7, "ok": true, "result": { "text": "...", "language": "pt", "durationSeconds": 3.2, "inferenceMs": 410 } }
// resposta erro
{ "id": 7, "ok": false, "error": { "code": "model-missing", "message": "..." } }
```

Comandos: STT `status`, `transcribe`, `shutdown`; TTS `status`, `voices`, `synthesize`.

### 5.2 STT — `faster-whisper`

- Modelos: `tiny`, `base`, `small` (default), `medium`, `large-v3`.
- `device=auto`: tenta CUDA (`compute_type=float16`); em falha (ex.: cuDNN ausente) usa CPU
  (`int8`, threads = metade dos núcleos). Reporta o device real no `status`.
- Modelo carregado uma vez por worker; shutdown ocioso após 10 min (configurável).
- `prepare` (fases): `venv` (cria com Python 3.10–3.12) → `pip` (`faster-whisper`) →
  `model` (download via `huggingface_hub`) → `load` (warm-up) → `ready`.
- Latência alvo: RTF < 0,5 em GPU; < 1,5 em CPU (modelo `small`, áudio pt-BR).

### 5.3 TTS — engines

| Engine | Implementação | Rede | Formato |
|---|---|---|---|
| `edge` | `edge-tts` (worker Python persistente) | sim | MP3 |
| `sapi` | PowerShell `System.Speech` (`runtime/sapi.ps1`), texto por arquivo UTF-8 | não | WAV 16-bit |
| `browser` | Web Speech API (`speechSynthesis`) no cliente | não | — |

Vozes: pt-BR `pt-BR-FranciscaNeural`, `pt-BR-AntonioNeural`,
`pt-BR-ThalitaMultilingualNeural`; en-US `en-US-AriaNeural`, `en-US-GuyNeural`,
`en-US-JennyNeural`, `en-US-BrianMultilingualNeural`. `rate`→`+N%`, `pitch`→`+NHz` (edge);
SAPI: `rate = clamp(round((rate-1)*10), -10, 10)`.

Seleção `engine=auto`: `edge` se disponível → `sapi` → erro acionável; o cliente pode cair
para `browser` como último recurso.

---

## 6. Cliente — slots e UI

### 6.1 Serviços e slots

| Plugin | `inject` (serviços) | Slots registrados |
|---|---|---|
| STT | `["slots","locale","connection","sessions"]` | `conversation.input.activity` (single), `settings.section` |
| TTS | `["slots","locale","connection","sessions"]` | `conversation.input.left` (list), `conversation.chat.assistant-actions` (list), `settings.section` |

O framework entrega **standardProps** aos ocupantes dos slots de composer/chat — entre eles
`sessionId`, `useChat`, `useSession`, `useSessions`, `useSessionStatus`, `inputActions`,
`useConversation`, `useProjection`, `useAccess`. As props específicas do slot:
- `conversation.chat.assistant-actions`: `{ messageId }`
- `settings.section`: `{ close }`

`inputActions`: `captureInsertion()`, `insertText(text, span)`, `setDraft(text)`, `submit()`,
`insertQuote(text)`, `addAttachments(ids)`, `removeAttachment(id)`.
`useChat(selector)` é hook seletor sobre o chat projetado do DSH.

### 6.2 STT — captura e inserção

```
getUserMedia({audio:{echoCancellation,noiseSuppression,deviceId?}})
  → MediaRecorder.start()
  → [usuário fala] → stop() → Blob → decodeAudioData
  → OfflineAudioContext(1, min(dur,60)*16000, 16000) → PCM f32 → WAV PCM16
  → base64 → RPC transcribe → insertText(text, captureInsertion())
```
- Estado: `idle | requesting | recording | transcribing | error`; `data-state` no botão.
- Nível: `AnalyserNode` RMS lido por `requestAnimationFrame`, atualizando CSS custom
  properties (sem re-render React por frame).
- Cancelamento (`Esc`/clique) libera tracks, fecha `AudioContext`, aborta RPC.
- Se `insertText` retornar `false` (draft mudou), recaptura e tenta 1×; último recurso
  `setDraft(draft + texto)`.
- Permissão negada/dispositivo ausente → toast acionável localizado (sem alert()).

### 6.3 TTS — seleção de texto, fila e playback

- Texto: `useChat` → percorre `timeline.turnOrder`/`locations.getTurn`/`nodes`; nós
  `assistant-step`: `data.blocks` (só `kind === "text"`), `data.finalNode.messageId`;
  ignora `reasoning` e (por padrão) blocos de código.
- Normalização markdown→fala: remove cercas/código inline, headings/bullets/ênfases,
  tabelas→frases, URLs→"link", emojis/símbolos técnica→espaço; colapsa espaços.
- Resolução de idioma: `lang = prefs.lang !== "auto" ? prefs.lang : detectLang(text)`;
  o idioma resolvido define a voz usada e o campo `lang` do `synthesize`. Amostras do
  Settings ignoram o override e usam o idioma da própria amostra.
- Chunking: sentenças ≤ ~600 chars (split em `. ! ? ; :` e quebras), fila com prefetch 1
  (próxima sintetiza enquanto a atual toca).
- Playback: `HTMLAudioElement` + `Blob`/`objectURL`; `stop()` pausa, limpa fila, revoga URLs,
  cancela RPCs em voo; troca de sessão/mensagem cancela.
- Auto-leitura: componente de `conversation.input.left` observa `useChat` + `useSession`;
  ao surgir novo `finalNode.messageId` de resposta final e `autoRead=true`, fala; dedupe por
  `messageId` (memória + `localStorage` `dsh-tts.read.<sessionId>`).
- Botão por mensagem: estado por `messageId` (idle/loading/speaking), play/stop.
- Política de autoplay: só inicia automaticamente após interação; se bloqueado, aviso acionável.

### 6.4 Settings

- `settings.section` com `id` (`voice-stt`, `voice-tts`), `order`, `label` localizado e
  componente próprio:
  - STT: status (Python/venv/deps/modelo/device), modelo, idioma padrão, dispositivo de
    entrada (enumerateDevices), preparar com progresso, testar gravação.
  - TTS: engine, **idioma da leitura** (`auto`/`pt-BR`/`en-US`), voz por idioma com amostra,
    rate/pitch, auto-leitura, pular código, preparar runtime com progresso, testar.

### 6.5 i18n, tema e persistência

- Dicionários próprios por namespace (`whisper-stt`, `tts`) com `pt` e `en`; segue o locale
  da GUI; fallback interno caso o assento `t` não seja injetado.
- CSS injetado uma vez com `data-plugin` e removido no dispose; **somente tokens `--dsw-*`**
  (`--dsw-alias-*`, `--dsw-color-*`) + `color-mix()`; sem hex/rgb; claro/escuro automático.
- Prefs: `localStorage` `dsh-whisper-stt.prefs` / `dsh-tts.prefs` (cache em memória);
  leituras/escritas tolerantes a falha.
- Diagnóstico: `window.__dshVoiceDebug.stt.rpc` / `.tts.rpc` (usado pelo E2E).

---

## 7. Erros, limites e resiliência

| Situação | Comportamento |
|---|---|
| Runtime STT ausente | `status.ready=false`; botão desabilitado com dica "Preparar"; UI não quebra |
| Modelo ausente | `transcribe` → `bad-request` com mensagem "modelo não preparado" |
| CUDA indisponível | worker usa CPU e reporta `device.fallback=true` |
| `edge-tts` offline | `synthesize` cai para `sapi` (auto) ou erro acionável |
| `useChat` ausente | botões por mensagem ocultos; "ler última" via DOM fallback; aviso único |
| Slot indisponível | `ctx.slots.inject` aguarda; plugin não derruba o app |
| RPC sem cookie | 401 da fence do DSH (antes do handler) |
| Payload inválido | `bad-request` com `details` (campo/motivo) |
| Worker morto | supervisor reinicia na próxima chamada (máx. 1 retry) |
| App desligando | `dispose` encerra workers e limpa timers |

Limites: áudio ≤ 4 MB base64 / ≤ 60 s; texto TTS ≤ 4000 chars; cache 50 MB/300 arquivos;
`prepare` concorrente é idempotente (single-flight).

Performance medida (RTX 3060, modelo `small`, harness real):

| Fluxo | Medida |
|---|---|
| STT pt-BR 9,10 s | CUDA `float16`: 653 ms (RTF 0,072); CPU `int8`: 2.563 ms (RTF 0,282) |
| STT en-US 6,05 s | CUDA `float16`: 332 ms (RTF 0,055) |
| Prepare STT (1ª vez) | ~41 s: venv → pip → cuda-libs → model (486 MB) → load → ready |
| TTS edge pt-BR/en-US | MP3 22–26 KB por sentença em ~1–2 s; cache hit <50 ms |
| TTS SAPI offline | WAV 16-bit em <1 s |
| Primeira resposta após ocioso (10 min) | +1–2 s de reload do modelo |

O E2E real (Chrome + DSH) valida UI, botões, RPC, síntese e transcrição; sem GPU o
fallback automático mantém o produto funcional.

---

## 8. Segurança e privacidade

- RPC exposto apenas em loopback, same-origin, com cookie de sessão (fence do DSH).
- Nenhum endpoint aceita caminho de arquivo, comando ou URL do cliente.
- Texto para SAPI via arquivo UTF-8 temporário (não por argumento) — evita injeção.
- Workers são processos-filho fixos do plugin, com scripts no pacote; nenhum shell arbitrário.
- Config/logs em `%USERPROFILE%\.dsh\dsh-voice\`; sem telemetria.
- STT local (áudio não sai da máquina); TTS neural envia texto à Microsoft (documentado;
  SAPI offline disponível).

---

## 9. Critérios de aceite (verificados)

1. `dsh plugin add` instala ambos os pacotes no profile; boot carrega servidor+cliente sem
   `console.error` e sem erro no loader.
2. GUI: botão de microfone no composer; controles de leitura à esquerda; botões nas respostas;
   seções de Settings renderizam.
3. STT: WAV pt-BR e en-US transcrevem corretamente (fixtures) e o texto entra no composer.
4. TTS: `synthesize` pt-BR/en-US devolve áudio válido (MP3 do edge; WAV do SAPI); playback
   toca, para e não sobrepõe; auto-leitura lê a resposta final.
5. Fallbacks: CPU sem CUDA; SAPI sem rede; browser speech sem engines do servidor.
6. Testes automatizados (`tests/run-all.ps1`): sync, smoke de cliente (SSR), testes de
   servidor (validação/proto), E2E real no profile `voice-dev` (:3099).
7. Segurança: endpoints rejeitam payloads inválidos/oversize/proto; nenhum caminho do cliente.

---

## 10. Roadmap

- Transcrição incremental (parciais) com VAD e detecção de fim de fala.
- Engine TTS on-device (Piper/Kokoro) para offline neural.
- Destaque da sentença em leitura (karaokê) e velocidade por sessão.
- Suporte macOS/Linux (SAPI→`say`/espeak; CUDA→CPU).
- Atalho global de ditado (push-to-talk com hotkey) e modo "segure para falar".

---

## 11. Publicação e distribuição (GitHub)

- **Repositório público:** `https://github.com/dgadelha1/dhs-stt-tts` (MIT).
- **Estrutura:** dois pacotes independentes em `packages/` (npm `link`/workspace local),
  instaláveis com `dsh plugin add -w <pacote>`; nenhum pacote é publicado no npm nesta versão.
- **Instalação por terceiros:** clone → `scripts/setup-runtime.ps1` → `scripts/install.ps1`.
  Os scripts descobrem o CLI do DSH e um Python 3.10–3.12 sem caminhos fixos de máquina.
- **Fonte × distribuição:** `src/` é a fonte; `lib/` é gerado por `scripts/sync.mjs` e é o
  que o DSH carrega (`prepack` roda o sync). O CI falha se `src` e `lib` divergirem.
- **CI (GitHub Actions):** `sync --check`, `node --check` dos pacotes, smoke do cliente
  (SSR) e testes de servidor (RPC/validação) em `ubuntu-latest` e `windows-latest`; E2E com
  Chrome e serviços externos não roda no CI.
- **Qualidade reproduzível:** `tests/run-all.ps1` executa o pipeline completo local
  (sync + smoke + servidor + E2E); relatórios em `tests/artifacts/`.
- **Versão:** `1.0.0` nos três `package.json` e no [CHANGELOG](CHANGELOG.md).

