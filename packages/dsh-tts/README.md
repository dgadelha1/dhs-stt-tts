# dsh-tts

Plugin de **leitura em voz alta** (text-to-speech) para o **DeepSeek Harness (DSH)**:
lê as respostas finais do assistente com voz **neural** (pt-BR e en-US), tem
**fallback offline** (SAPI do Windows) e um último recurso no **navegador**
(Web Speech API). Inclui botão global no composer, botão por mensagem,
leitura automática e uma seção de configurações própria.

> Versão: 1.0.0 · DSH 0.2.2-rc.1 · plugin `dsh-tts` (bundle id `tts`)

---

## Recursos

- **Motor neural online** via [`edge-tts`](https://pypi.org/project/edge-tts/)
  (vozes `pt-BR-FranciscaNeural`, `pt-BR-AntonioNeural`,
  `pt-BR-ThalitaMultilingualNeural`, `en-US-AriaNeural`, `en-US-GuyNeural`,
  `en-US-JennyNeural`, `en-US-BrianMultilingualNeural`).
- **Fallback offline** via `System.Speech` (SAPI) do Windows — funciona sem rede.
- **Último recurso** no navegador via `speechSynthesis` (Web Speech).
- **Automático**: tenta o neural online, cai para o SAPI offline e, por fim, para
  o navegador — sem sobrepor áudio e sem quebrar a página.
- **Botão global** no composer: ler a última resposta / parar + toggle de
  leitura automática + indicador discreto de "Falando…".
- **Botão por mensagem**: ler/parar cada resposta final, identificada pelo
  `messageId` durável.
- **Idioma da leitura explícito**: automático (detecta pelo texto) ou fixo em
  pt-BR/en-US, aplicado ao botão global, por mensagem e à leitura automática.
- **Leitura automática** de novas respostas, com deduplicação por `messageId`
  (memória + `localStorage`, por sessão).
- **Normalização markdown → fala**: remove cercas de código (configurável),
  marcações, listas e tabelas; links viram a palavra "link"; blocos de
  raciocínio (`reasoning`) nunca são lidos.
- **Fila por sentença** (≤ 600 caracteres) com **prefetch 1**; trocar de
  mensagem/sessão ou parar cancela a fila, pausa o áudio e libera os object URLs.
- **Cache LRU** de áudio no host (50 MB / 300 arquivos), chave
  `sha256(engine|voice|rate|pitch|texto)`.
- Configurações: motor, idioma da leitura, voz por idioma com amostra,
  velocidade, tom, leitura automática, pular código, status do runtime com
  preparação e botão de teste.
- i18n **pt-BR / en-US**; CSS exclusivamente com tokens `--dsw-*`.

---

## Requisitos

| Requisito | Detalhes |
|---|---|
| DSH | 0.2.2-rc.1 (GUI web) |
| Python | **3.10+** para o motor neural (o `prepare` cria um venv isolado) |
| Rede | necessária para o motor neural (Microsoft Edge read-aloud) |
| Windows | necessário para o motor SAPI (`System.Speech`) |
| Vozes SAPI | pt-BR: `Microsoft Maria Desktop`; en-US: `Microsoft Zira Desktop` (instale pelo Windows, ver Troubleshooting) |
| Navegador | qualquer navegador moderno para o fallback Web Speech |

O motor neural usa `edge-tts==7.3.1` (pinado em `runtime/requirements.txt`).
Versões antigas (ex.: 7.2.7) falham com `403 WSServerHandshakeError` porque o
token DRM do serviço Edge mudou — o worker faz **1 retry** com backoff curto e,
se persistir, o plugin cai automaticamente para o SAPI.

---

## Instalação

Requisitos: DSH `0.2.2-rc.1`, Windows 10/11 e Python 3.10–3.12. A partir da raiz do
repositório **dhs-stt-tts**:

```powershell
dsh plugin --profile <profile> add -w .\packages\dsh-tts

# ou pelo instalador do repositório
pwsh -File scripts\install.ps1 -OnlyTts -Profile <profile>
```

O `package.json` declara `dsh.bundle.patch` (`cordis.patch.yml`, id `tts`), então
o CLI adiciona o plugin a `dsh.profile.bundles`. Depois recarregue a página da GUI.
No primeiro uso, abra **Configurações → Voz (TTS)** e clique em
**Preparar runtime** para criar o venv Python e instalar o `edge-tts`
(uma vez; requer rede).

---

## Motores e fallback

| Motor | Onde roda | Online? | Formato | Observações |
|---|---|---|---|---|
| `edge` | worker Python persistente no host (`runtime/tts_worker.py`) | sim | MP3 | Vozes neurais; melhor qualidade |
| `sapi` | PowerShell `System.Speech` (`runtime/sapi.ps1`) | não | WAV 16-bit mono 22.05 kHz | Texto passado por **arquivo UTF-8** (nunca por argumento) |
| `browser` | cliente (`speechSynthesis`) | depende | — | Último recurso; seleciona voz pt-BR/en-US |

Modo `auto` (padrão): `edge` → `sapi` → `browser`. O cliente divide o texto em
sentenças e só inicia a próxima após a anterior terminar; parar cancela também o
trabalho no host (`cancel`).

---

## Idiomas (pt-BR e en-US)

O `dsh-tts` fala **apenas dois idiomas**: **português (Brasil, `pt-BR`)** e
**inglês (Estados Unidos, `en-US`)**. Outros idiomas não são suportados: a lista
de vozes é fechada e o servidor valida a voz antes de sintetizar.

### Escolha da voz por idioma

Em **Configurações → Voz (TTS)** há um seletor de voz para cada idioma
(**Voz em português** e **Voz em inglês**), com as opções neurais (online) e
SAPI (offline) do idioma:

| Idioma | Vozes neurais (`edge`) | Vozes offline (SAPI) |
|---|---|---|
| `pt-BR` | `pt-BR-FranciscaNeural`, `pt-BR-AntonioNeural`, `pt-BR-ThalitaMultilingualNeural` | `Microsoft Maria Desktop` |
| `en-US` | `en-US-AriaNeural`, `en-US-GuyNeural`, `en-US-JennyNeural`, `en-US-BrianMultilingualNeural` | `Microsoft Zira Desktop` |

"Padrão do motor" usa a primeira voz disponível do idioma. As vozes SAPI não
instaladas no Windows aparecem desabilitadas na lista.

### Como fixar o idioma da leitura

Em **Configurações → Voz (TTS) → Idioma da leitura**:

- **Automático** (padrão): o idioma é detectado pelo texto da resposta com uma
  heurística local (acentos e palavras comuns) e a voz do idioma detectado é
  usada.
- **Português (BR)** / **English (US)**: fixa o idioma no `synthesize` e na
  escolha da voz, **mesmo que o texto pareça estar no outro idioma**. Útil para
  respostas mistas, termos técnicos, nomes próprios ou quando a detecção erra.

O idioma fixo vale para toda a conversa: botão global do composer, "ler última
resposta", botão por mensagem e leitura automática de novas respostas. As
**amostras** de voz continuam tocando no idioma da amostra (o ▶ ao lado de "Voz
em português" fala em pt-BR; o de "Voz em inglês", em en-US). O botão **Testar**
segue o idioma fixo quando houver; em automático, usa o idioma da interface.

A preferência é salva em `localStorage` (`dsh-tts.prefs`) como
`lang: "auto" | "pt-BR" | "en-US"`; valores inválidos são tolerados e voltam
para `auto`. A API do servidor (`/voice-tts`) não muda: o cliente sempre envia
o `lang` já resolvido no payload de `synthesize`.

### Fallback SAPI por idioma

Sem o motor neural, o SAPI usa a voz do idioma escolhido: pt-BR →
`Microsoft Maria Desktop`; en-US → `Microsoft Zira Desktop`. Se a voz exata não
estiver instalada, ele cai para a primeira voz instalada daquele idioma; sem
nenhuma voz do idioma, o SAPI usa a voz padrão do sistema — por isso, para
qualidade consistente, instale as vozes dos dois idiomas (ver Troubleshooting).

---

## Configurações (Configurações → Voz (TTS))

- **Motor**: automático, neural online, offline (SAPI) ou navegador.
- **Idioma da leitura**: automático (detecta pelo texto), Português (BR) ou
  English (US) — ver [Idiomas](#idiomas-pt-br-e-en-us).
- **Voz em português / inglês**: lista fechada com vozes neurais e SAPI
  (as SAPI não instaladas aparecem desabilitadas); botão ▶ para amostra.
- **Velocidade**: 0,5× a 2×.
- **Tom**: −20 Hz a +20 Hz (não se aplica ao SAPI/navegador).
- **Ler automaticamente novas respostas**: começa quando o turno termina.
- **Pular blocos de código**: cercas de código não são lidas.
- **Runtime de voz**: checks (neural ✓/✗, SAPI, navegador, Python), barra de
  progresso do `prepare`, botão **Preparar runtime**, atualizar status e
  **Testar**.
- **Cache**: número de arquivos e tamanho ocupado.

Preferências ficam em `localStorage` sob `dsh-tts.prefs`. Marcas de leitura
automática ficam em `dsh-tts.read.<sessionId>` (retenção de 7 dias, no máximo 80
por sessão).

---

## Runtime e arquivos

Diretório de dados: `DSH_VOICE_HOME` ou `%USERPROFILE%\.dsh\dsh-voice`.

```
<home>/tts/
├── venv/          # Python venv criado por "Preparar runtime"
├── cache/         # MP3/WAV sintetizados (LRU: 50 MB / 300 arquivos)
├── logs/          # worker.log, pip.log, runtime.log (diagnóstico)
└── config.json    # preferências persistidas pelo host (atômico: temp + rename)
```

Variáveis de ambiente opcionais:

- `DSH_VOICE_HOME` — raiz de dados alternativa.
- `DSH_VOICE_PYTHON` — caminho de um Python 3.10+ específico.
- O `prepare` procura Python nesta ordem: `DSH_VOICE_PYTHON` → venv existente →
  `py -3.12` → Python do runtime do DSH → `py -3` → `python` → `python3`.

O `config.json` é lido de forma tolerante (JSON inválido cai nos defaults) e
escrito com `temp file + rename`. `dispose` do plugin encerra o worker Python,
cancela a preparação e limpa timers.

---

## Contrato RPC (`/voice-tts`)

O cliente chama via `ctx.connection.rpc.call('/voice-tts', endpoint, payload)`.
Toda resposta é `{ ok: true, value }` ou
`{ ok: false, error: { code, message, details } }`, com `code` em
**`bad-request`** ou **`internal`**. Apenas propriedades conhecidas do payload
são lidas (sem path de arquivo, sem comando arbitrário; `__proto__`/
`constructor` não são despachados).

| Endpoint | Payload | Retorno (resumo) |
|---|---|---|
| `status` | `{}` | engines (edge/sapi/browser), vozes, defaults, cache, limites, `prepare` |
| `voices` | `{ lang? }` | catálogo fechado por idioma/engine (com `installed` no SAPI) |
| `prepare` | `{ engine?: "edge" }` | `{ started, running, phase, progress… }` (idempotente) |
| `prepareStatus` | `{}` | `{ running, phase, progress, message, error, installedVersion, prepared }` |
| `synthesize` | `{ text, lang: "pt-BR"\|"en-US", voice?, rate? 0.5–2, pitch? −20..20, engine? "auto"\|"edge"\|"sapi" }` | `{ audioBase64, mime, engine, voice, cached, bytes }` |
| `cancel` | `{}` | `{ cancelled: true }` — mata o worker e cancela o `prepare` |

Limites do servidor: texto ≤ **4000** caracteres (vazio/whitespace → `bad-request`);
rate 0.5–2; pitch −20..20 Hz; vozes validadas contra a lista fechada.

### Hook de diagnóstico (E2E)

Após o `apply`, o cliente expõe:

```js
window.__dshVoiceDebug.tts = {
  plugin: "tts",
  version: "1.0.0",
  rpc: (endpoint, payload) => callRpc(appCtx, endpoint, payload),
  state: () => ({ status: "idle|loading|speaking", messageId, lang, engine, error, notice }),
  stop: () => stop(),
  speak: (text, lang) => speak({ text, lang }),
};
```

Seletores estáveis para E2E: `[data-voice-tts-button]` (ler/parar global),
`[data-voice-tts-auto]` (toggle de auto-leitura),
`[data-voice-tts-controls][data-voice-tts-state="idle|loading|speaking"]`,
`[data-voice-tts-message-button][data-message-id]` (por mensagem) e
`[data-voice-tts-settings]` (seção de configurações).

---

## Privacidade

- **Motor neural (`edge`)**: o **texto** das respostas é enviado ao serviço de
  leitura da Microsoft para gerar o áudio. Nada é gravado do microfone (este
  plugin não captura áudio).
- **Motor SAPI** e **navegador**: processamento local/offline (o navegador pode
  usar vozes locais ou do sistema).
- **Cache**: guarda somente o áudio sintetizado, localmente, sob
  `<home>/tts/cache` (50 MB / 300 arquivos, limpeza automática). O cache não sai
  da máquina.
- **Preferências/estado**: `localStorage` do navegador (`dsh-tts.prefs`,
  `dsh-tts.read.<sessionId>`) e `config.json` local.
- O servidor não registra o texto sintetizado em log; logs de runtime contêm
  apenas diagnóstico do processo (pip/worker).

---

## Solução de problemas

**"Falha na preparação: Python 3.10+ não encontrado"**
Instale Python 3.10+ ou defina `DSH_VOICE_PYTHON` para o executável. O DSH já
traz um Python 3.12 em `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`,
que é detectado automaticamente.

**Motor neural falha (403/erro de rede)**
O worker tenta 1 retry; se persistir, o modo `auto` usa o SAPI. Atualize o venv
(Configurações → Preparar runtime) e confira `logs/worker.log`. O pin
`edge-tts==7.3.1` é o validado; versões antigas recebem 403.

**SAPI indisponível / sem vozes**
Instale as vozes pelo Windows: Configurações → Hora e idioma → Fala →
Adicionar vozes (pt-BR: Maria; en-US: Zira). Depois reabra as Configurações do
DSH (os checks são reconsultados). Em hosts sem Windows, use `edge` ou
`browser`.

**"O navegador bloqueou o áudio"**
Política de autoplay: clique no botão de ler (gesto do usuário) para iniciar; a
leitura automática precisa de uma interação prévia com a página.

**Não aparece botão por mensagem**
O botão só existe para respostas finais com `messageId` e texto. Se o snapshot do
chat mudar de forma, o plugin degrada com segurança: o botão global continua
lendo a última resposta via extração DOM de último recurso.

**Preparação travada**
Clique em **Parar**/`cancel` (RPC) ou recarregue a página; o `prepare` é
idempotente e pode ser reiniciado.

**Cache crescendo**
O limite é 50 MB / 300 arquivos, aplicado no boot e após gravações. Apague
`<home>/tts/cache` com o DSH parado para reiniciar do zero.

---

## Testes (desenvolvimento)

Fora do pacote publicado (não incluído em `files`), o desenvolvimento mantém
harnesses locais:

```
node --check src/index.js
node --check src/client.js
node scripts/sync.mjs --package dsh-tts     # src/ -> lib/
```

Cobertura executada na entrega: `node --check` em todos os `.js`; teste do bundle
cliente sem browser (stub `window.__ModuleLoader__`, React real,
`react-dom/server`, 87 asserções); teste do servidor com ctx falso e engines
reais edge + SAPI (100 asserções: endpoints, `bad-request`, proto-pollution,
cache, cancel/recuperação, dispose); síntese real pt-BR/en-US (edge MP3 e SAPI
WAV RIFF 16-bit); boot real no profile de teste com RPC via browser (CDP).

---

## English summary

`dsh-tts` reads assistant answers aloud in the DSH GUI. It ships three engines:
neural **edge-tts** (online, pt-BR/en-US), **Windows SAPI** (offline), and the
browser **Web Speech API** as a last resort. It supports exactly **two reading
languages (pt-BR and en-US)** and lets the user either detect the language from
the text or **pin a reading language** (Settings → Voice (TTS) → Reading
language), which fixes both `synthesize` and voice selection. Features: auto-read
of new answers (deduplicated by durable `messageId`), per-message read/stop
buttons, a composer toolbar control, markdown→speech normalization, a sentence
queue (≤ 600 chars) with one prefetch, clean cancellation, and an LRU audio
cache (50 MB / 300 files). Preferences live in `localStorage`
(`dsh-tts.prefs`); runtime state lives under
`%USERPROFILE%\.dsh\dsh-voice\tts` (venv, cache, logs, config.json).
Privacy: with the neural engine the **text** is sent to Microsoft's read-aloud
service; SAPI and the browser engine run locally. The RPC channel is
`/voice-tts` (`status`, `voices`, `prepare`, `prepareStatus`, `synthesize`,
`cancel`); errors are only `bad-request` or `internal`.

## Licença

MIT — veja [`LICENSE`](./LICENSE).

