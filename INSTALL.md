# Instalação — DSH Voice Suite

Guia completo para instalar os plugins **`dsh-whisper-stt`** (ditado com Whisper) e
**`dsh-tts`** (leitura neural) no DeepSeek Harness, incluindo o setup do runtime Python local.

> **Idiomas:** apenas **português (BR)** e **inglês (US)**. Para configurar o idioma do ditado
> e da leitura, veja **[docs/LANGUAGES.md](docs/LANGUAGES.md)**.

---

## 1. Pré-requisitos

| Requisito | Versão | Como verificar |
|---|---|---|
| DeepSeek Harness | `0.2.2-rc.1` (validado) | `dsh --version` (CLI) ou app Desktop instalado |
| Windows | 10/11 | O fallback SAPI é do Windows — plataforma validada |
| Python | 3.10–3.12 (**3.12 recomendado**) | O setup encontra um Python válido automaticamente |
| Rede (instalação) | PyPI + Hugging Face | Necessária para venvs e modelo Whisper |
| GPU (opcional) | CUDA 12 + cuDNN 9 | Sem isso o Whisper roda em CPU (`int8`) |
| Espaço em disco | ~1,5 GB | Modelo `small` (~250 MB de download) + venvs + cache |

> **Python:** o `python` do PATH pode ser 3.13/3.14 (sem wheels de `ctranslate2`). O setup
> procura, nesta ordem: `DSH_VOICE_PYTHON`/`DSH_STT_PYTHON` → `py -3.12`/`-3.11`/`-3.10` →
> `python`/`python3` (validando 3.10–3.12) → runtime embutido do app DSH. Também aceita
> `-PythonPath <exe>`.

---

## 2. Instalação a partir do repositório (recomendada)

```powershell
git clone https://github.com/dgadelha1/dhs-stt-tts.git
cd dhs-stt-tts

# 1) Runtime local: venvs (faster-whisper + edge-tts) e modelo Whisper
pwsh -File scripts\setup-runtime.ps1
#    opções: -Model small|base|medium|large-v3   -SkipModel   -PythonPath <exe>   -NoEdge   -Check

# 2) Instalar os dois plugins no profile do DSH (default: desktop)
pwsh -File scripts\install.ps1
#    opções: -Profile desktop|web|<nome>   -Check   -Remove   -OnlyStt   -OnlyTts

# 3) Reiniciar o DeepSeek Harness (o boot compõe os bundles dos plugins)
```

No app Desktop: feche e abra o aplicativo (ou recarregue a GUI com `Ctrl+R` após o hot‑apply).
Em instalação CLI (`dsh`): reinicie o processo. Depois recarregue a página (F5).

**Verificação rápida:** a GUI deve mostrar o botão de **microfone** no composer e os controles de
**leitura** à esquerda dele; em *Configurações* aparecem **“Ditado por voz”** e **“Voz (TTS)”**.

---

## 3. Instalação manual (controle total)

### 3.1 Descobrir o CLI e o profile ativo

| Instalação | Profile | Como confirmar |
|---|---|---|
| App Desktop (Electron) | `desktop` | `DSH_PROFILE=desktop` no processo; a GUI é servida pelo app |
| CLI `dsh` | normalmente `web` | `dsh plugin --profile <nome> list` |

```powershell
# use o caminho completo do CLI se não estiver no PATH
dsh plugin --profile desktop add -w .\packages\dsh-whisper-stt
dsh plugin --profile desktop add -w .\packages\dsh-tts
```

O CLI instala via pnpm, reconcilia `dsh.profile.bundles` e o boot seguinte carrega as duas
metades (servidor Cordis + bundle cliente). Os plugins são independentes — instale só o que quiser.

> **`ERR_PNPM_IGNORED_BUILDS` (pnpm 11):** pode abortar por causa do build script do `koffi` e
> não reconciliar os bundles. Correção (também feita pelo instalador): adicione ao
> `pnpm-workspace.yaml` do profile
> ```yaml
> allowBuilds:
>   koffi: false
> ```
> e repita o `add`.

### 3.2 Setup do runtime sem o script

```powershell
# STT (use um Python 3.10–3.12)
<python> -m venv "$env:USERPROFILE\.dsh\dsh-voice\stt\venv"
& "$env:USERPROFILE\.dsh\dsh-voice\stt\venv\Scripts\python.exe" -m pip install -U pip
& "$env:USERPROFILE\.dsh\dsh-voice\stt\venv\Scripts\python.exe" -m pip install "faster-whisper==1.2.1"

# TTS
<python> -m venv "$env:USERPROFILE\.dsh\dsh-voice\tts\venv"
& "$env:USERPROFILE\.dsh\dsh-voice\tts\venv\Scripts\python.exe" -m pip install "edge-tts==7.3.1"
```

O modelo Whisper é baixado no primeiro `prepare` (Configurações → Ditado por voz → **Preparar**)
ou pelo script; por padrão `small` em `%USERPROFILE%\.dsh\dsh-voice\stt\models`.

---

## 4. Configuração de idioma (pt‑BR / en‑US)

| O que | Onde | Opções |
|---|---|---|
| **O que o ditado ouve** | chevron no botão do microfone **e/ou** Configurações → Ditado por voz → *Idioma padrão* | Automático · Português (BR) · English (US) |
| **O que a leitura fala** | Configurações → Voz (TTS) → *Idioma da leitura* | Automático · Português (BR) · English (US) |
| **Voz de cada idioma** | Configurações → Voz (TTS) → *Voz em português* / *Voz em inglês* | Francisca/Antonio/Thalita · Aria/Guy/Jenny/Brian · SAPI Maria/Daniel/Zira |

Passo a passo completo, armazenamento das preferências e solução de “idioma errado”:
**[docs/LANGUAGES.md](docs/LANGUAGES.md)**.

---

## 5. Arquivos e diretórios

| Caminho | Conteúdo |
|---|---|
| `%USERPROFILE%\.dsh\dsh-voice\stt\` | `venv/`, `models/`, `logs/`, `config.json` |
| `%USERPROFILE%\.dsh\dsh-voice\tts\` | `venv/`, `cache/`, `logs/`, `config.json` |
| `%USERPROFILE%\.dsh\dsh-voice\logs\` | logs de setup e workers |
| GUI → Configurações | preferências principais (idioma, modelo, vozes, velocidade) |

### Variáveis de ambiente (opcionais)

| Variável | Efeito |
|---|---|
| `DSH_VOICE_HOME` | Raiz alternativa para venvs/modelos/cache (default `%USERPROFILE%\.dsh\dsh-voice`) |
| `DSH_STT_PYTHON` / `DSH_VOICE_PYTHON` | Caminho de um Python 3.10–3.12 para o venv STT |
| `DSH_TTS_PYTHON` | Idem para o TTS |
| `DSH_STT_DEVICE` | `auto` (default), `cuda` ou `cpu` |
| `DSH_STT_MODEL` | Modelo default (`tiny`, `base`, `small`, `medium`, `large-v3`) |

---

## 6. Uso

1. **Ditado:** clique no microfone → fale → clique novamente (ou `Esc`) → texto inserido no composer.
   Idioma no chevron (Auto/pt‑BR/en‑US).
2. **Leitura:** alto‑falante em cada resposta final; botão global à esquerda do composer lê a
   última resposta e alterna a leitura automática.
3. Ajustes em **Configurações → Ditado por voz / Voz (TTS)**.

---

## 7. Verificação

```powershell
# Plugins instalados no profile?
dsh plugin --profile desktop list | Select-String 'dsh-whisper-stt|dsh-tts'

# Runtime presente?
Test-Path "$env:USERPROFILE\.dsh\dsh-voice\stt\venv\Scripts\python.exe"
Test-Path "$env:USERPROFILE\.dsh\dsh-voice\tts\venv\Scripts\python.exe"

# Modelo Whisper presente?
Get-ChildItem "$env:USERPROFILE\.dsh\dsh-voice\stt\models" -ErrorAction SilentlyContinue
```

Harness automatizado (profile isolado `voice-dev`, porta 3099 — não afeta sua instalação):

```powershell
pwsh -File scripts\dev-server.ps1          # sobe a GUI de teste (imprime URL com token)
pwsh -File tests\run-all.ps1               # sync + smoke + servidor + E2E
pwsh -File scripts\dev-server.ps1 -Stop    # encerra o servidor de teste
```

---

## 8. Remoção

```powershell
# um plugin
dsh plugin --profile desktop remove dsh-whisper-stt

# ambos + runtime local
pwsh -File scripts\install.ps1 -Remove
```

Reinicie o app. Para apagar venvs/modelos/cache: remova `%USERPROFILE%\.dsh\dsh-voice`
(nada mais do DSH é alterado pelos plugins).

---

## 9. Solução de problemas

| Sintoma | Diagnóstico / solução |
|---|---|
| `add` falha com `ERR_PNPM_IGNORED_BUILDS` | Aplique `allowBuilds: {koffi: false}` no `pnpm-workspace.yaml` do profile (ver §3.1). |
| Plugins não aparecem na GUI | O boot compõe os bundles: reinicie o app/CLI e recarregue a página. Confira com `plugin list`. A **aba Plug-ins** compõe a lista de instalados no boot: após instalar em runtime, recarregue/reinicie para vê-la (a instalação hot-apply já ativa as funções). |
| Botão de microfone ausente | O cliente do plugin não carregou: veja o console do navegador (`Ctrl+Shift+I`) e `%USERPROFILE%\.dsh\dsh-voice\logs\`. |
| Microfone pede permissão e falha | Permita microfone no Windows (Privacidade → Microfone) e no app. |
| “Runtime não está pronto” | Configurações → Ditado por voz → **Preparar** (ou `setup-runtime.ps1`). |
| Download do modelo falha | Rede/proxy: verifique `HTTPS_PROXY`; o download vem do Hugging Face. |
| Transcrição lenta / sem GPU | CPU (`cuDNN`/cuBLAS ausente) → use `small`/`base` ou rode o setup com CUDA. |
| Texto errado em pt‑BR | Fixe **Português (BR)** no chevron do microfone; use modelo `medium`/`large-v3` se necessário. |
| Leitura em idioma errado | Fixe **Idioma da leitura** em Voz (TTS) — veja [docs/LANGUAGES.md](docs/LANGUAGES.md). |
| Sem áudio no TTS | `edge` exige rede; troque para **SAPI** (offline) ou verifique volume/saída. |
| Voz não encontrada (SAPI) | Instale vozes em Windows → Configurações → Hora e idioma → Fala. |
| Leitura automática não dispara | O navegador/app precisa de uma interação do usuário antes de tocar áudio; clique na página e reative o toggle. |
| Áudio atrasado/travando | Reduza a velocidade; o cache do TTS é limpo automaticamente ao passar de 50 MB. |

---

## 10. Segurança e privacidade

- Áudio do ditado vai **somente** para o processo local do DSH (`127.0.0.1`); Whisper roda na sua máquina.
- TTS neural (`edge`) envia o texto ao serviço da Microsoft; escolha `SAPI` para uso offline.
- Nenhum endpoint aceita caminhos de arquivo do navegador; o texto do TTS chega ao PowerShell por arquivo UTF‑8.
- Os plugins não coletam telemetria.



