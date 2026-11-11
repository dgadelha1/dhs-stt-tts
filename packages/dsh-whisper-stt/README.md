# dsh-whisper-stt — ditado por voz local com Whisper

Plugin do **DeepSeek Harness** que adiciona ditado por voz ao composer usando
**Whisper local** (`faster-whisper`): um botão de microfone grava, transcreve no
próprio computador e insere o texto no campo de mensagem. Interface em
**português (BR)** e **inglês (US)**.

- **Privacidade**: o áudio é processado localmente e **nunca sai da máquina**.
  A única rede usada é o download do modelo a partir do HuggingFace (uma vez,
  durante a preparação) e, opcionalmente, o download do runtime CUDA (pip).
- **GPU quando disponível**: o worker tenta CUDA (`float16`), valida com uma
  inferência real e cai automaticamente para CPU (`int8`) quando
  CUDA/cuBLAS/cuDNN não estão utilizáveis.
- **Modelos**: `tiny`, `base`, `small` (padrão), `medium`, `large-v3`.
- **Privacidade de logs**: transcrições não são gravadas em log; só métricas
  (duração, latência, device).

## Instalação

Requisitos: DSH `0.2.2-rc.1`, Windows 10/11 e Python 3.10–3.12. A partir da raiz do
repositório **dhs-stt-tts**:

```powershell
# instala só este plugin no profile (app Desktop = desktop)
dsh plugin --profile <profile> add -w .\packages\dsh-whisper-stt

# ou pelo instalador do repositório (inclui checagens e AllowBuilds)
pwsh -File scripts\install.ps1 -OnlyStt -Profile <profile>
```

Reinicie/recarregue a GUI. Depois, em **Configurações → Ditado por voz**, clique em
**Preparar / baixar modelo** (cria o venv, instala `faster-whisper` e baixa o modelo).

> Setup completo do runtime por CLI (venv + modelo + bibliotecas CUDA):
> `pwsh -File scripts\setup-runtime.ps1 -OnlyStt`.

### Requisitos

| Item | Versão |
|---|---|
| DSH | 0.2.2-rc.1 (GUI web) |
| Python | **3.10–3.12** (recomendado 3.12; 3.13/3.14 são recusados automaticamente por falta de wheels testadas do ctranslate2) |
| Node | 20+ (runtime do DSH) |
| Disco | ~1,5 GB (venv + modelo `small`; modelos maiores proporcionalmente) |
| GPU (opcional) | NVIDIA com driver recente; cuBLAS via `pip` (`nvidia-cublas-cu12`) |

Detecção de Python (em ordem): venv existente → `DSH_VOICE_PYTHON` →
`config.pythonPath` → `py -3.12` / `-3.11` / `-3.10` → runtime Python do DSH
(`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python`) → `python3` →
`python`. O interpretador escolhido aparece em `status.checks`.

### Onde ficam os arquivos

Diretório base: `$DSH_VOICE_HOME` ou `%USERPROFILE%\.dsh\dsh-voice`; o STT usa
`<base>\stt\`:

```
stt\
├── venv\          # ambiente Python gerenciado
├── models\        # cache do modelo (HF)
├── logs\          # worker.log, setup.log
└── config.json    # modelo, idioma, device, cudaLibs, limites
```

`config.json` (editável; escrita atômica pelo plugin):

```json
{
  "model": "small",
  "language": "auto",
  "device": "auto",
  "cudaLibs": "auto",
  "pythonPath": null,
  "maxAudioSeconds": 60,
  "idleShutdownMinutes": 10
}
```

## Uso

- **Microfone no composer**: clique para começar (`idle`), clique de novo para
  parar e transcrever (`recording` → `transcribing`). `Esc` cancela; o `X`
  descarta a gravação; o seletor ao lado escolhe **Auto / Português (BR) /
  English (US)**. O nível do microfone é animado em tempo real e há timer
  `mm:ss`; a duração máxima configurável é 60 s (limite rígido 120 s).
- **Configurações → Ditado por voz**: status do runtime (checks Python, venv,
  faster-whisper, modelo, GPU/CUDA), modelo, idioma padrão, dispositivo
  (automático/GPU/CPU), bibliotecas CUDA, duração máxima, descarregamento do
  modelo por ociosidade, botão **Preparar** com fases e barra de progresso e
  botão **Testar microfone** (grava ~4 s e transcreve de verdade).
- **Erros acionáveis**: falha de runtime mostra um toast inline com o botão
  **Preparar**, sem `alert()`.

## Idiomas (pt-BR e en-US)

**Somente português (Brasil) e inglês (Estados Unidos)** são suportados — no ditado e na
interface. O servidor aceita apenas `auto`, `pt` e `en` (sinônimos `pt-BR`/`en-US`); qualquer
outro valor retorna `bad-request` com mensagem clara.

| Controle | Onde | Efeito | Salvo em |
|---|---|---|---|
| Seletor rápido | chevron no **botão do microfone** | idioma da próxima ditada (lembrado) | `localStorage["dsh-whisper-stt.prefs"].language` |
| Idioma padrão | **Configurações → Ditado por voz → Idioma padrão** | padrão do runtime e do botão **Testar microfone** | `%USERPROFILE%\.dsh\dsh-voice\stt\config.json` (`language`) |

- **Automático:** o Whisper detecta o idioma falado (pt/en) por fala.
- **Fixo (pt-BR/en-US):** o idioma é imposto à transcrição — melhor precisão e latência em
  falas curtas.
- Guia completo (incluindo a leitura do plugin TTS): **[docs/LANGUAGES.md](../../docs/LANGUAGES.md)**.

## RPC (`/voice-stt`)

Envelope: `POST /voice-stt/<endpoint>` com
`{"type":"client-request","rpcId":"…","method":"<endpoint>","payload":{…}}`
(resposta `{"type":"server-response","rpcId":"…","result":{"ok":true,"value":…}}`).

| Endpoint | Payload | Resultado |
|---|---|---|
| `status` | `{}` | checks, modelos, config, runtime, limites, caminhos |
| `prepare` | `{model?}` | inicia a preparação (idempotente) e retorna o snapshot |
| `prepareStatus` | `{}` | `{phase,progress,message,error,steps}` |
| `transcribe` | `{audioBase64,language?,model?}` | `{text,language,durationSeconds,inferenceMs,model,device,computeType}` |
| `cancel` | `{}` | cancela preparação/worker em execução |
| `setConfig` | patch | persiste config validada e reinicia o worker se necessário |

Erros usam somente `bad-request` e `internal`. Áudio aceito: WAV **PCM16 mono
16 kHz**, ≤ **4 MB** (decodificado) e ≤ `maxAudioSeconds`.

## Arquitetura

- `lib/index.js` (servidor Cordis): registra o canal RPC na `connection`,
  gerencia o venv/pip/modelo (`prepare`), valida áudio, controla o worker e
  persiste config. `apply()` retorna disposer que encerra worker/timers.
- `runtime/worker.py`: processo persistente do `faster-whisper`, protocolo
  **JSON Lines** em stdin/stdout (stdout só JSON; diagnóstico em stderr →
  `logs/worker.log`). Carrega o modelo uma vez, valida o device com uma
  inferência real e encerra após 10 min ocioso (configurável).
- `lib/client.js` (bundle sem build, só `require("react")`): botão do composer
  (`conversation.input.activity`), seção de configurações (`settings.section`
  id `voice-stt`), i18n pt/en, CSS só com tokens `--dsw-*`, prefs em
  `localStorage["dsh-whisper-stt.prefs"]` e hook de diagnóstico
  `window.__dshVoiceDebug.stt = { plugin, version, rpc }`.

## Desempenho medido (RTX 3060 12 GB, modelo `small`)

Fixture pt-BR de 9,10 s e en-US de 6,05 s (vozes SAPI), transcritas via RPC
`/voice-stt/transcribe` no profile de teste:

| Device | Compute | Áudio | Inferência | RTF | Texto |
|---|---|---|---|---|---|
| CUDA | `float16` | 9,10 s | 653 ms | **0,072** | “Teste de ditado em português. O rato roeu…” |
| CUDA | `float16` | 6,05 s | 332 ms | **0,055** | “This is an English dictation test. The quick brown fox…” |
| CPU | `int8` | 9,10 s | 2.563 ms (estável) | **0,282** | idêntico ao CUDA |
| CPU (1ª chamada, inclui load do modelo) | `int8` | 9,10 s | 7.678 ms | 0,844 | — |

`setConfig {device:"cpu"}` reinicia o worker e usa CPU imediatamente;
`device:"auto"` volta a carregar a GPU. Em uma máquina sem GPU ou sem as DLLs
CUDA, tudo funciona em CPU com RTF ~0,25–0,35 (fala normal continua mais rápida
que tempo real).

## GPU (CUDA) — como habilitar

O wheel do `faster-whisper` **não** embute o cuBLAS exigido pelo
`ctranslate2` no Windows. O plugin resolve isso de duas formas:

1. **Automático (padrão, `cudaLibs: "auto"`)**: durante o `prepare`, se houver
   GPU NVIDIA visível, o plugin instala `nvidia-cublas-cu12` no venv (fase
   **cuda-libs** do `prepareStatus`) e adiciona
   `venv\Lib\site-packages\nvidia\cublas\bin` ao `PATH` do worker — o
   `ctranslate2` encontra `cublas64_12.dll` e usa CUDA `float16`.
   O `ctranslate2` 4.9 já traz `cudnn64_9.dll` embutido; se sua instalação
   exigir cuDNN separado, instale `nvidia-cudnn-cu12` do mesmo jeito.
2. **Manual** (sem rede no `prepare`, ou `cudaLibs: "off"`):

   ```powershell
   $venv = "$env:USERPROFILE\.dsh\dsh-voice\stt\venv\Scripts\python.exe"
   & $venv -m pip install --disable-pip-version-check nvidia-cublas-cu12 nvidia-cudnn-cu12
   ```

   Reinstale/reprepare o plugin (ou apenas transcodifique de novo): o worker
   novo herda o `PATH` aumentado.

O worker **valida o device com uma inferência real** ao carregar o modelo
(`prepareStatus.phase = load`). Se CUDA falhar (cuBLAS/cuDNN ausente, driver
antigo), ele registra o erro em `logs/worker.log`, troca para
**CPU (`int8`) automaticamente** e reporta o device real em
`status.runtime.device` / `runtime.cuda.compute = "unavailable"`. Nada quebra:
o ditado continua funcionando, só mais lento. `status.checks[cuda]` mostra
`GPU visível · compute CUDA: ok | unavailable | unverified`, e
`cudaLibs: "off"` força o caminho CPU sem tentar instalar nada.


## Troubleshooting

| Sintoma | Causa / solução |
|---|---|
| `status` mostra `modelo small não baixado` | Clique em **Preparar** (baixa ~250–500 MB do HuggingFace). |
| Erro `Library cublas64_12.dll is not found` | GPU visível mas sem cuBLAS. Deixe `cudaLibs: auto` (o prepare instala `nvidia-cublas-cu12` no venv) **ou** use `device: cpu`. O fallback CPU é automático. |
| `CUDA indisponível (cuBLAS/cuDNN)` no `prepareStatus` | Mesma causa acima: o worker validou CUDA e caiu para CPU. Funciona, só mais lento. |
| `wheel ... is not supported` / 3.13–3.14 | Python 3.13/3.14 não têm wheels testadas do `ctranslate2`. Instale Python 3.12 ou aponte `DSH_VOICE_PYTHON`/`pythonPath` para ele. |
| `pip install falhou` / sem rede | Prepare precisa de PyPI e HuggingFace. Ver `logs/setup.log`. |
| Transcrição vazia | Fale mais perto do microfone; o VAD descarta silêncio. Teste em Configurações → **Testar microfone**. |
| Microfone não grava | O navegador exige HTTPS ou `localhost`; permita o microfone no cadeado da barra de endereço. |
| Worker travado/VRAM presa | Ajuste "Descarregar modelo após (min)" (padrão 10) ou clique em **Cancelar** durante a preparação; o plugin reinicia o worker na próxima transcrição. |
| Logs | `<base>\stt\logs\worker.log` (worker) e `setup.log` (pip/venv/modelo). |

## Desinstalação

```powershell
dsh plugin --profile <profile> remove dsh-whisper-stt
```

O runtime em `~/.dsh/dsh-voice/stt` pode ser apagado manualmente; o plugin não
toca em nada fora desse diretório.

## Licença

MIT.


