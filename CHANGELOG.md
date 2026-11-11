# Changelog

Todas as mudanças relevantes deste projeto. Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento semântico.

## [1.0.0] — 2026-11-11

Primeira versão pública do **DSH Voice Suite**: dois plugins independentes para o
DeepSeek Harness, com suporte a **português (BR)** e **inglês (US)**.

### Adicionado

- **`dsh-whisper-stt`** — ditado por voz no composer:
  - botão de microfone na GUI com estados, nível de entrada (RMS), timer e cancelamento (`Esc`);
  - seletor de idioma **Automático / pt‑BR / en‑US** no botão, com padrão nas configurações
    (veja [docs/LANGUAGES.md](docs/LANGUAGES.md));
  - inserção no cursor (`inputActions.insertText`) sem apagar o rascunho, com recuperação segura;
  - Whisper **local** (`faster-whisper` 1.2.1), persistente, com **CUDA** (`float16`) e fallback
    automático para **CPU** (`int8`); VAD Silero; VAD/beam configuráveis;
  - preparação idempotente (`venv → pip → cuda-libs → model → load → ready`) com progresso,
    download do modelo pelo Hugging Face, e CUDA via wheels `nvidia-cublas-cu12`;
  - seção de configurações com checks de runtime, modelo, idioma, dispositivo, duração
    máxima, descarregamento ocioso e **teste real de microfone**;
  - API RPC `/voice-stt`: `status`, `prepare`, `prepareStatus`, `transcribe`, `cancel`, `setConfig`;
  - validação estrita de WAV (RIFF/WAVE, PCM16, mono, 16 kHz), limites de tamanho/duração e
    erros acionáveis; áudio nunca sai da máquina.
- **`dsh-tts`** — leitura das respostas:
  - botão **ler/parar** por mensagem final e controles globais (ler última resposta + toggle de
    leitura automática) no composer;
  - **idioma da leitura** fixo ou automático (`auto`/`pt-BR`/`en-US`) com voz por idioma —
    veja [docs/LANGUAGES.md](docs/LANGUAGES.md);
  - vozes neurais **`edge-tts` 7.3.1** (Francisca/Antonio/Thalita; Aria/Guy/Jenny/Brian) com
    fallback **SAPI offline** (Maria/Daniel/Zira) e último recurso **Web Speech**;
  - normalização de markdown para fala, divisão por sentenças com prefetch, cancelamento
    imediato e cache LRU (50 MB/300 arquivos);
  - API RPC `/voice-tts`: `status`, `prepare`, `prepareStatus`, `synthesize`, `voices`, `cancel`.
- **Infraestrutura**: scripts `setup-runtime`/`install`/`dev-server`/`sync` para Windows,
  harness de testes (smoke cliente com SSR, servidor com RPC real, E2E com Chrome e microfone
  simulado por arquivo), fixtures WAV pt/en, CI para GitHub Actions e documentação completa
  (README pt/en, INSTALL, SPEC, LANGUAGES, CONTRIBUTING).
- **Idiomas**: somente **pt‑BR** e **en‑US** são suportados; qualquer outro valor é recusado
  pelo servidor.

### Segurança

- RPC protegido pela fence do DSH (loopback + same-origin + cookie); nenhum caminho de arquivo
  aceito do cliente; texto do TTS entregue ao PowerShell por arquivo UTF‑8 (sem injeção);
  validação estrita de payloads (incluindo proteção contra `__proto__`); sem telemetria.

### Conhecido

- Leitura automática de uma **nova** resposta exige uma interação prévia na página (política de
  autoplay do navegador) — o toggle mostra o estado e a dica.
- Vozes neurais (`edge-tts`) exigem internet; offline usa SAPI.
- Windows é a única plataforma validada (o fallback SAPI é do Windows).
