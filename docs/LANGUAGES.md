# 🌎 Idiomas — Português (BR) e English (US) · Languages

> **Apenas dois idiomas são suportados: português brasileiro (`pt-BR`) e inglês americano (`en-US`).**
> O servidor recusa qualquer outro valor (`auto | pt | en` apenas) e a interface dos plugins é
> publicada em português e inglês. Outros locales da GUI caem em inglês.
>
> *Only Brazilian Portuguese (`pt-BR`) and US English (`en-US`) are supported. Any other value is
> rejected by the server (`auto | pt | en` only), and the plugins' UI ships in Portuguese and
> English. Other GUI locales fall back to English.*

Este guia cobre **como definir o idioma que o ditado ouve** e **como definir o idioma que a
leitura fala**, incluindo onde a preferência é salva e o que acontece no modo automático.

---

## 🎙️ Ditado (speech-to-text) — idioma que ele **ouve**

O Whisper aceita três modos: `Automático`, `Português (BR)` e `English (US)`.

### Onde escolher

| Controle | Onde fica | Efeito | Onde é salvo |
|---|---|---|---|
| **Seletor rápido do ditado** | chevron no próprio **botão do microfone** (o ícone abre um popover com Auto / pt‑BR / en‑US) | define o idioma da **próxima ditada** e fica lembrado para as seguintes | `localStorage` → `dsh-whisper-stt.prefs` (campo `language`) |
| **Idioma padrão** | **Configurações → Ditado por voz → Idioma padrão** | define o padrão do runtime/servidor e do botão **Testar microfone** da própria seção | `%USERPROFILE%\.dsh\dsh-voice\stt\config.json` (campo `language`) |

### Como funciona

- **Automático:** o Whisper detecta o idioma falado e devolve `pt` ou `en` junto do texto.
  Bom para uso misto; em falas curtas ou nomes próprios pode errar.
- **Fixo (pt‑BR ou en‑US):** o idioma é enviado ao servidor e o Whisper **não detecta** — usa
  esse idioma. Recomendado para precisão e latência quando você sempre fala um idioma.
- **Reconhecimento:** só `auto`, `pt`, `en` (aceita também `pt‑BR`, `en‑US` como sinônimos) são
  aceitos; qualquer outro valor retorna `bad-request` com mensagem clara.
- **Privacidade:** a detecção é local (Whisper na sua máquina). Nada do áudio é enviado para fora.

### Passo a passo — ditar em português

1. Clique no chevron do botão do microfone → selecione **Português (BR)**.
2. (Opcional) **Configurações → Ditado por voz → Idioma padrão → Português (BR)**.
3. Clique em **Preparar** se o runtime ainda não estiver pronto.
4. Clique no microfone, fale e clique de novo. O texto entra no campo.

### Passo a passo — ditar em inglês

1. Chevron do microfone → **English (US)**. (ou deixe **Automático**).
2. Fale normalmente; o texto entra no campo no idioma escolhido.

---

## 🔊 Leitura (text-to-speech) — idioma que ela **fala**

O TTS aceita `Automático`, `Português (BR)` e `English (US)` para o **idioma da leitura**, e
permite escolher uma **voz diferente para cada idioma**.

### Onde escolher

| Controle | Onde fica | Efeito | Onde é salvo |
|---|---|---|---|
| **Idioma da leitura** | **Configurações → Voz (TTS) → Idioma da leitura** | `Automático` detecta o idioma de cada resposta; `Português (BR)`/`English (US)` **força** o idioma (e a voz) em toda leitura | `localStorage` → `dsh-tts.prefs` (campo `lang`) |
| **Voz em português** | Configurações → Voz (TTS) → *Voz em português* | escolhe a voz pt‑BR usada quando o idioma resolvido for português | `dsh-tts.prefs` (campo `voices["pt-BR"]`) |
| **Voz em inglês** | Configurações → Voz (TTS) → *Voz em inglês* | escolhe a voz en‑US usada quando o idioma resolvido for inglês | `dsh-tts.prefs` (campo `voices["en-US"]`) |
| **Amostra** | botões de amostra ao lado das vozes | toca uma frase de demonstração no idioma da **amostra** (não no idioma forçado) | — |

### Como funciona

1. O texto da resposta é normalizado para fala (sem código, links viram “link”, listas/tabelas
   viram frases).
2. O idioma é resolvido: **fixo** (se você escolheu pt‑BR/en‑US) ou **detectado** pelo texto
   (modo automático).
3. A voz é escolhida na lista do idioma resolvido: neurais (`edge-tts`, online) ou **SAPI**
   (offline) — com a mesma configuração de voz por idioma.
4. A fila fala sentença por sentença; os botões `parar` cancelam imediatamente.

### Vozes disponíveis

| Idioma | `edge-tts` (neural, online) | SAPI (Windows, offline) |
|---|---|---|
| **pt‑BR** | `pt-BR-FranciscaNeural`, `pt-BR-AntonioNeural`, `pt-BR-ThalitaMultilingualNeural` | `Microsoft Maria Desktop`, `Microsoft Daniel` |
| **en‑US** | `en-US-AriaNeural`, `en-US-GuyNeural`, `en-US-JennyNeural`, `en-US-BrianMultilingualNeural` | `Microsoft Zira Desktop` |

> As vozes SAPI variam por máquina. As que não estiverem instaladas aparecem como
> “não instalada” e nunca são escolhidas automaticamente. Vozes neurais exigem internet;
> sem rede o plugin cai sozinho para SAPI.

### Passo a passo — ouvir em português

1. **Configurações → Voz (TTS) → Idioma da leitura → Português (BR)**.
2. Escolha **Voz em português** (ex.: Francisca).
3. Passe o mouse em qualquer resposta final → clique no **alto‑falante**; ou use o botão global
   “ler última resposta” no composer.

### Passo a passo — ouvir em inglês

1. **Idioma da leitura → English (US)**; escolha **Voz em inglês** (ex.: Aria).
2. Clique no alto‑falante de uma resposta em inglês (ou do botão global).

### Passo a passo — automático (detecta por resposta)

1. **Idioma da leitura → Automático**.
2. Cada resposta é lida no idioma detectado no **texto** da resposta, usando a voz configurada
   para aquele idioma. Respostas mistas usam o idioma predominante.
3. Se a detecção errar, fixe o idioma (acima) — é o ajuste mais confiável.

### Leitura automática (auto‑read)

- Ligue o **toggle de leitura automática** ao lado do botão global de alto‑falante.
- Ao final de cada **nova** resposta, o TTS fala usando o idioma resolvido (fixo ou detectado).
- Preferência salva em `dsh-tts.prefs` (`autoRead`). A leitura pode ser interrompida a qualquer
  momento pelo botão de parar.

---

## ⚙️ Onde as preferências ficam

| Preferência | Arquivo / chave |
|---|---|
| Idioma do ditado (seletor do microfone) | navegador: `localStorage["dsh-whisper-stt.prefs"].language` |
| Idioma padrão do ditado (runtime) | `%USERPROFILE%\.dsh\dsh-voice\stt\config.json` → `language` |
| Idioma e vozes da leitura, velocidade, tom, auto‑leitura | navegador: `localStorage["dsh-tts.prefs"]` (`lang`, `voices`, `rate`, `pitch`, `autoRead`, `skipCode`, `engine`) |
| Cache de áudio do TTS | `%USERPROFILE%\.dsh\dsh-voice\tts\cache` |

> As preferências do navegador são por **perfil do navegador/usuário**. Para redefinir, abra o
> painel Configurações e ajuste os controles, ou limpe as chaves acima no DevTools.

---

## 🧪 Teste rápido de idiomas

1. **Ditado pt‑BR:** chevron do mic = Português (BR) → fale “teste de ditado em português, um dois três”.
2. **Ditado en‑US:** chevron = English (US) → fale “English dictation test, one two three”.
3. **Leitura pt‑BR:** Idioma da leitura = Português (BR) → alto‑falante em uma resposta qualquer.
4. **Leitura en‑US:** Idioma da leitura = English (US) → alto‑falante na mesma resposta.
5. **Automático:** Idioma da leitura = Automático → uma resposta em português e outra em inglês
   devem sair com vozes diferentes.

---

## ❌ Limites

- **Não suportado:** espanhol, francês, alemão, italiano, japonês, chinês etc. — nem no ditado
  nem na leitura (as vozes/ASR disponíveis no projeto são só pt‑BR e en‑US).
- UI dos plugins: pt/en. GUI do DSH em outro idioma → textos dos plugins em inglês (fallback).
- O TTS não traduz: ele lê o texto como está, no idioma escolhido/detectado.
