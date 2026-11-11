/**
 * dsh-tts — client half.
 *
 * Hand-written bundle in the DSH client-module format (no build step):
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * The factory requires only `react`; everything else comes from the client
 * runtime services handed to apply(ctx): slots, locale, connection, sessions.
 *
 * Contributions:
 *   - `conversation.input.left` (list, session scope): global speaker button
 *     (read the last assistant answer / stop), an auto-read toggle and a subtle
 *     "speaking…" indicator.
 *   - `conversation.chat.assistant-actions` (list, session scope): a per-message
 *     read/stop button driven by the durable `messageId` owner prop.
 *   - `settings.section` (id `voice-tts`): engine, per-language voice with a
 *     sample button, rate/pitch sliders, auto-read, skip-code, runtime status
 *     with `prepare` progress and a test button.
 *
 * Assistant text comes from the framework-provided `useChat` selector hook
 * (standard prop of every session-scoped Chat/composer slot). Extraction is
 * defensive: when the snapshot shape is unexpected or unavailable it degrades
 * to a DOM fallback encapsulated in `readLastAnswerFromDom()`; per-message
 * buttons hide themselves instead of throwing.
 *
 * Playback is a sentence queue (<= 600 chars) with one prefetched synthesis.
 * Switching message/session cancels cleanly: generation token, paused audio,
 * revoked object URLs, cancelled speechSynthesis. When both server engines
 * fail, the client falls back to `speechSynthesis` (browser) with a pt-BR/en-US
 * voice selection.
 */
window.__ModuleLoader__.load({
	id: "dsh-tts",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useMemo = React.useMemo;
		var useSyncExternalStore = React.useSyncExternalStore;

		// ───────────────────────── constants ─────────────────────────
		var CHANNEL = "/voice-tts";
		var VERSION = "1.0.0";
		var NS = "tts";
		var PREFS_KEY = "dsh-tts.prefs";
		var READ_KEY_PREFIX = "tts.read.";
		var MAX_SENTENCE_CHARS = 600;
		var MAX_READ_MARKS = 80;
		var READ_MARK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

		/** UI defaults, also the fallback when the server has no config yet. */
		var DEFAULT_PREFS = {
			engine: "auto",
			lang: "auto",
			autoRead: false,
			skipCode: true,
			rate: 1,
			pitch: 0,
			voices: { "pt-BR": null, "en-US": null },
		};

		/** Supported values for the explicit reading language preference. */
		var READING_LANGS = ["auto", "pt-BR", "en-US"];

		/**
		 * Coerce any persisted/UI value into the supported reading-language set.
		 * @param {unknown} value
		 * @returns {'auto' | 'pt-BR' | 'en-US'}
		 */
		function normalizeReadingLang(value) {
			return value === "pt-BR" || value === "en-US" ? value : "auto";
		}

		/** Client-side mirrors of the server voice catalog (for prefs without RPC). */
		var EDGE_VOICES = {
			"pt-BR": ["pt-BR-FranciscaNeural", "pt-BR-AntonioNeural", "pt-BR-ThalitaMultilingualNeural"],
			"en-US": ["en-US-AriaNeural", "en-US-GuyNeural", "en-US-JennyNeural", "en-US-BrianMultilingualNeural"],
		};
		var SAPI_VOICES = {
			"pt-BR": ["Microsoft Maria Desktop", "Microsoft Maria", "Microsoft Daniel"],
			"en-US": ["Microsoft Zira Desktop", "Microsoft David Desktop", "Microsoft Mark"],
		};
		var SAMPLE_TEXT = {
			"pt-BR": "Olá! Esta é uma amostra da voz em português.",
			"en-US": "Hello! This is a sample of the English voice.",
		};

		// ───────────────────────── tiny helpers ─────────────────────────
		/** @returns {React.ReactElement} */
		function h(tag, props) {
			var children = Array.prototype.slice.call(arguments, 2);
			return React.createElement.apply(React, [tag, props].concat(children));
		}
		function cx() {
			var out = [];
			for (var i = 0; i < arguments.length; i += 1) if (arguments[i]) out.push(arguments[i]);
			return out.join(" ");
		}
		function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}
		function messageOf(error) {
			if (error && typeof error.message === "string" && error.message !== "") return error.message;
			return String(error || "unknown error");
		}
		function isObject(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		/** Run `fn` and return its result, or null when it throws. */
		function safely(fn) {
			try {
				return fn();
			} catch (error) {
				return null;
			}
		}
		/** Minimal external store used for prefs and playback state. */
		function createStore(initial) {
			var value = initial;
			var listeners = new Set();
			return {
				getSnapshot: function () {
					return value;
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () {
						listeners.delete(listener);
					};
				},
				set: function (next) {
					var resolved = typeof next === "function" ? next(value) : next;
					if (resolved === value) return;
					value = resolved;
					listeners.forEach(function (listener) {
						try {
							listener();
						} catch (error) {
							/* a listener must never break other consumers */
						}
					});
				},
			};
		}

		// ───────────────────────── icons (SVG, stroke 1.6, currentColor) ─────
		function svg(children) {
			return h(
				"svg",
				{
					viewBox: "0 0 24 24",
					width: 16,
					height: 16,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.6,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": true,
					focusable: false,
				},
				children,
			);
		}
		function IconSpeaker(props) {
			return svg([
				h("path", { key: "c", d: "M11 5 6.5 9H3v6h3.5L11 19V5z" }),
				h("path", props && props.waves === false ? null : { key: "w1", d: "M15 8.6a4.6 4.6 0 0 1 0 6.8" }),
				h("path", props && props.waves === false ? null : { key: "w2", d: "M18 6a8.7 8.7 0 0 1 0 12" }),
			]);
		}
		function IconStop() {
			return svg([h("rect", { key: "r", x: 6.5, y: 6.5, width: 11, height: 11, rx: 2, fill: "currentColor", stroke: "none" })]);
		}
		function IconAuto() {
			return svg([
				h("path", { key: "a", d: "M3 12h2.2l1.6-4 2.6 9 2.2-6 1.5 3H21" }),
			]);
		}
		function IconRefresh() {
			return svg([
				h("path", { key: "p", d: "M20 11a8 8 0 1 0-2.3 6.3" }),
				h("path", { key: "h", d: "M20 4v7h-7" }),
			]);
		}
		function IconPlay() {
			return svg([h("path", { key: "p", d: "M8 5.5l11 6.5-11 6.5v-13z" })]);
		}
		function IconCheck(props) {
			return svg([h("path", { key: "c", d: "M4.5 12.5l5 5 10-11", stroke: props && props.color ? props.color : "currentColor" })]);
		}
		function IconCross() {
			return svg([h("path", { key: "c", d: "M6 6l12 12M18 6 6 18" })]);
		}
		function Spinner() {
			return h("span", { className: "tts-spinner", "aria-hidden": true });
		}

		// ───────────────────────── styles (tokens only) ─────────────────────
		var CSS = `
.tts-ctl{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%}
.tts-btn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.tts-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.tts-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:1px}
.tts-btn:disabled{opacity:.5;cursor:default;background:transparent}
.tts-btn[data-state="speaking"]{color:var(--dsw-alias-state-business-primary)}
.tts-btn[data-on="on"]{color:var(--dsw-alias-state-business-primary)}
.tts-ctl-status{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tts-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);animation:tts-pulse 1.2s ease-in-out infinite}
.tts-notice{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.25;color:var(--dsw-alias-state-warn-label);max-width:280px}
.tts-notice-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@keyframes tts-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
@keyframes tts-spin{to{transform:rotate(360deg)}}
.tts-spinner{width:12px;height:12px;border-radius:50%;border:1.6px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 45%,transparent);border-top-color:var(--dsw-alias-label-primary);animation:tts-spin .8s linear infinite;flex:none}
.tts-msg-btn{width:28px;height:28px}
.tts-settings{display:flex;flex-direction:column;gap:14px;padding:2px 0 20px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:640px}
.tts-settings-head{display:flex;flex-direction:column;gap:2px}
.tts-settings-title{font-size:15px;font-weight:600}
.tts-settings-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.35}
.tts-card{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1))}
.tts-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.tts-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.tts-row-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.tts-row-label{color:var(--dsw-alias-label-primary)}
.tts-row-hint{font-size:11.5px;line-height:1.35;color:var(--dsw-alias-label-tertiary)}
.tts-select{min-width:190px;max-width:100%;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:5px 7px;outline:none}
.tts-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:0}
.tts-select:disabled{opacity:.55}
.tts-slider{display:flex;align-items:center;gap:10px;min-width:190px}
.tts-slider input[type="range"]{flex:1;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.tts-slider input[type="range"]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.tts-slider-value{font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:42px;text-align:right}
.tts-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary)}
.tts-check input{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;margin:0}
.tts-check input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:2px}
.tts-btn-primary{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;flex:none}
.tts-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.tts-btn-primary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:2px}
.tts-btn-primary:disabled{opacity:.55;cursor:default}
.tts-btn-ghost{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;flex:none}
.tts-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.tts-btn-ghost:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:2px}
.tts-btn-ghost:disabled{opacity:.55;cursor:default}
.tts-checks{display:flex;flex-direction:column;gap:6px}
.tts-check-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.tts-check-row .tts-ok{color:var(--dsw-alias-state-success-primary);display:inline-flex}
.tts-check-row .tts-bad{color:var(--dsw-alias-state-error-primary);display:inline-flex}
.tts-check-row .tts-muted{color:var(--dsw-alias-label-tertiary);display:inline-flex}
.tts-check-detail{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%}
.tts-progress{display:flex;flex-direction:column;gap:6px}
.tts-bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.tts-bar-fill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:999px;transition:width .25s ease}
.tts-phase{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:7px}
.tts-error{font-size:12px;color:var(--dsw-alias-state-error-primary);line-height:1.35}
.tts-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.4}
.tts-samples{display:inline-flex;gap:6px;flex-wrap:wrap}
`;

		/**
		 * Claim the plugin's single `<style>` element through a disposer owned by
		 * `ctx.effect`, so unloading the plugin removes it again.
		 * @returns {() => void}
		 */
		function claimStyles() {
			if (typeof document === "undefined") return function () {};
			var style = document.querySelector('style[data-plugin="dsh-tts"]');
			if (!style) {
				style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-tts");
				style.textContent = CSS;
				document.head.appendChild(style);
			}
			return function () {
				if (style.parentNode) style.parentNode.removeChild(style);
			};
		}

		// ───────────────────────── i18n ─────────────────────────
		var dict = {
			pt: {
				"settings.nav": "Voz (TTS)",
				"settings.title": "Leitura em voz alta",
				"settings.subtitle": "Ouça as respostas do assistente com vozes neurais em português e inglês.",
				"settings.engine": "Motor de voz",
				"settings.engine.auto": "Automático (neural e offline)",
				"settings.engine.edge": "Neural online (edge-tts)",
				"settings.engine.sapi": "Offline (SAPI do Windows)",
				"settings.engine.browser": "Navegador (Web Speech)",
				"settings.engine.hint": "O modo automático usa a voz neural online e recorre ao SAPI offline quando não há rede.",
				"settings.lang": "Idioma da leitura",
				"settings.lang.auto": "Automático (detecta pelo texto)",
				"settings.lang.pt": "Português (BR)",
				"settings.lang.en": "English (US)",
				"settings.lang.hint": "Automático detecta o idioma pelo texto da resposta. Fixar o idioma melhora a escolha da voz, mesmo que o texto pareça estar em outro idioma.",
				"settings.voicePt": "Voz em português",
				"settings.voiceEn": "Voz em inglês",
				"settings.voice.online": "Neural (online)",
				"settings.voice.offline": "Offline (SAPI)",
				"settings.voice.notInstalled": "(não instalada)",
				"settings.voice.default": "Padrão do motor",
				"settings.sample": "Ouvir amostra",
				"settings.rate": "Velocidade",
				"settings.pitch": "Tom",
				"settings.pitchUnsupported": "O motor SAPI não ajusta o tom.",
				"settings.autoRead": "Ler automaticamente novas respostas",
				"settings.autoRead.hint": "A leitura começa quando o assistente termina a resposta.",
				"settings.skipCode": "Pular blocos de código",
				"settings.skipCode.hint": "Cercas de código não são lidas em voz alta.",
				"settings.runtime": "Runtime de voz",
				"settings.runtime.edge": "Neural (edge-tts)",
				"settings.runtime.sapi": "SAPI (offline)",
				"settings.runtime.browser": "Navegador (Web Speech)",
				"settings.runtime.ready": "Pronto",
				"settings.runtime.notReady": "Não instalado",
				"settings.runtime.available": "Disponível",
				"settings.runtime.unavailable": "Indisponível",
				"settings.runtime.voices": "{count} vozes",
				"settings.runtime.python": "Python {version}",
				"settings.runtime.noPython": "Python 3.10+ não encontrado",
				"settings.prepare": "Preparar runtime",
				"settings.prepare.running": "Preparando…",
				"settings.prepare.hint": "Instala o venv Python e o pacote edge-tts (uma vez, precisa de rede).",
				"settings.refresh": "Atualizar status",
				"settings.test": "Testar",
				"settings.cache": "Cache de áudio",
				"settings.cache.value": "{files} arquivos · {size}",
				"settings.cache.empty": "vazio",
				"settings.privacy": "Com o motor neural ativo, as frases são enviadas ao serviço de leitura da Microsoft. O motor SAPI e o do navegador funcionam offline.",
				"settings.phase.check": "Verificando o Python…",
				"settings.phase.venv": "Criando o ambiente virtual…",
				"settings.phase.pip": "Instalando o edge-tts…",
				"settings.phase.verify": "Verificando o runtime neural…",
				"settings.phase.worker": "Iniciando o worker neural…",
				"settings.phase.ready": "Runtime neural pronto.",
				"settings.phase.error": "Falha na preparação.",
				"settings.phase.cancelled": "Preparação cancelada.",
				"settings.phase.idle": "Aguardando.",
				"controls.read": "Ler a última resposta em voz alta",
				"controls.stop": "Parar leitura",
				"controls.autoOn": "Desativar leitura automática",
				"controls.autoOff": "Ativar leitura automática",
				"controls.speaking": "Falando…",
				"controls.loading": "Preparando áudio…",
				"controls.nothing": "Nenhuma resposta para ler ainda.",
				"controls.error": "Não foi possível falar: {message}",
				"controls.autoplay": "O navegador bloqueou o áudio. Clique em ler novamente.",
				"controls.retry": "Tentar novamente",
				"controls.fallback": "Voz neural indisponível; usando a voz do navegador.",
				"message.read": "Ler esta resposta em voz alta",
				"message.stop": "Parar a leitura desta resposta",
				"message.loading": "Preparando a leitura desta resposta",
				"error.voice": "Não foi possível sintetizar a voz.",
			},
			en: {
				"settings.nav": "Voice (TTS)",
				"settings.title": "Read aloud",
				"settings.subtitle": "Listen to assistant answers with neural voices in Portuguese and English.",
				"settings.engine": "Voice engine",
				"settings.engine.auto": "Automatic (neural then offline)",
				"settings.engine.edge": "Neural online (edge-tts)",
				"settings.engine.sapi": "Offline (Windows SAPI)",
				"settings.engine.browser": "Browser (Web Speech)",
				"settings.engine.hint": "Automatic uses the online neural voice and falls back to offline SAPI without network.",
				"settings.lang": "Reading language",
				"settings.lang.auto": "Automatic (detect from text)",
				"settings.lang.pt": "Portuguese (BR)",
				"settings.lang.en": "English (US)",
				"settings.lang.hint": "Automatic detects the language from the answer text. Fixing it improves voice selection even when the text looks like another language.",
				"settings.voicePt": "Portuguese voice",
				"settings.voiceEn": "English voice",
				"settings.voice.online": "Neural (online)",
				"settings.voice.offline": "Offline (SAPI)",
				"settings.voice.notInstalled": "(not installed)",
				"settings.voice.default": "Engine default",
				"settings.sample": "Play sample",
				"settings.rate": "Speed",
				"settings.pitch": "Pitch",
				"settings.pitchUnsupported": "The SAPI engine cannot change pitch.",
				"settings.autoRead": "Read new answers automatically",
				"settings.autoRead.hint": "Playback starts when the assistant finishes an answer.",
				"settings.skipCode": "Skip code blocks",
				"settings.skipCode.hint": "Code fences are not read aloud.",
				"settings.runtime": "Voice runtime",
				"settings.runtime.edge": "Neural (edge-tts)",
				"settings.runtime.sapi": "SAPI (offline)",
				"settings.runtime.browser": "Browser (Web Speech)",
				"settings.runtime.ready": "Ready",
				"settings.runtime.notReady": "Not installed",
				"settings.runtime.available": "Available",
				"settings.runtime.unavailable": "Unavailable",
				"settings.runtime.voices": "{count} voices",
				"settings.runtime.python": "Python {version}",
				"settings.runtime.noPython": "Python 3.10+ not found",
				"settings.prepare": "Prepare runtime",
				"settings.prepare.running": "Preparing…",
				"settings.prepare.hint": "Installs the Python venv and the edge-tts package (once, needs network).",
				"settings.refresh": "Refresh status",
				"settings.test": "Test",
				"settings.cache": "Audio cache",
				"settings.cache.value": "{files} files · {size}",
				"settings.cache.empty": "empty",
				"settings.privacy": "With the neural engine active, sentences are sent to Microsoft's read-aloud service. The SAPI and browser engines work offline.",
				"settings.phase.check": "Checking Python…",
				"settings.phase.venv": "Creating the virtual environment…",
				"settings.phase.pip": "Installing edge-tts…",
				"settings.phase.verify": "Verifying the neural runtime…",
				"settings.phase.worker": "Starting the neural worker…",
				"settings.phase.ready": "Neural runtime ready.",
				"settings.phase.error": "Preparation failed.",
				"settings.phase.cancelled": "Preparation cancelled.",
				"settings.phase.idle": "Idle.",
				"controls.read": "Read the last answer aloud",
				"controls.stop": "Stop reading",
				"controls.autoOn": "Turn automatic reading off",
				"controls.autoOff": "Turn automatic reading on",
				"controls.speaking": "Speaking…",
				"controls.loading": "Preparing audio…",
				"controls.nothing": "No answer to read yet.",
				"controls.error": "Could not speak: {message}",
				"controls.autoplay": "The browser blocked audio. Press read again.",
				"controls.retry": "Try again",
				"controls.fallback": "Neural voice unavailable; using the browser voice.",
				"message.read": "Read this answer aloud",
				"message.stop": "Stop reading this answer",
				"message.loading": "Preparing this answer",
				"error.voice": "Could not synthesize speech.",
			},
		};

		/** @returns {Record<string, string>} */
		function dictT(key, vars) {
			var table = dict.en || {};
			var tablePt = dict.pt || {};
			var text = table[key] != null ? table[key] : tablePt[key] != null ? tablePt[key] : key;
			if (vars) {
				text = String(text).replace(/\{(\w+)\}/g, function (match, name) {
					return vars[name] != null ? String(vars[name]) : match;
				});
			}
			return text;
		}

		/** Slot components normally receive `t`; otherwise bind through the service. */
		function bindT(ctx, props) {
			if (props && typeof props.t === "function") return props.t;
			try {
				if (ctx && ctx.locale && typeof ctx.locale.bind === "function") {
					var bound = ctx.locale.bind(NS);
					if (typeof bound === "function") return bound;
				}
			} catch (error) {
				/* locale service unavailable */
			}
			return dictT;
		}

		// ───────────────────────── app context & rpc ─────────────────────────
		var appCtx = null;

		function rpcErrorOf(error) {
			var wrapped = new Error((error && error.message) || "unknown error");
			wrapped.code = error && error.code;
			return wrapped;
		}

		/**
		 * Call one `/voice-tts` endpoint and unwrap `{ ok, value }`.
		 * @param {unknown} ctx
		 * @param {string} endpoint
		 * @param {Record<string, unknown>} [payload]
		 */
		async function callRpc(ctx, endpoint, payload) {
			var result = await ctx.connection.rpc.call(CHANNEL, endpoint, payload || {});
			if (!result || result.ok !== true) throw rpcErrorOf(result && result.error);
			return result.value;
		}

		// ───────────────────────── preferences ─────────────────────────
		var prefsCache = null;

		/** Normalize any persisted value into the supported prefs shape. */
		function normalizePrefs(raw) {
			var prefs = {
				engine: DEFAULT_PREFS.engine,
				lang: DEFAULT_PREFS.lang,
				autoRead: false,
				skipCode: true,
				rate: DEFAULT_PREFS.rate,
				pitch: DEFAULT_PREFS.pitch,
				voices: { "pt-BR": null, "en-US": null },
			};
			if (!isObject(raw)) return prefs;
			if (raw.engine === "auto" || raw.engine === "edge" || raw.engine === "sapi" || raw.engine === "browser") {
				prefs.engine = raw.engine;
			}
			prefs.lang = normalizeReadingLang(raw.lang);
			prefs.autoRead = raw.autoRead === true;
			prefs.skipCode = raw.skipCode !== false;
			if (typeof raw.rate === "number" && Number.isFinite(raw.rate)) prefs.rate = clamp(raw.rate, 0.5, 2);
			if (typeof raw.pitch === "number" && Number.isFinite(raw.pitch)) prefs.pitch = clamp(Math.round(raw.pitch), -20, 20);
			if (isObject(raw.voices)) {
				["pt-BR", "en-US"].forEach(function (lang) {
					var value = raw.voices[lang];
					if (typeof value === "string" && value !== "") prefs.voices[lang] = value;
				});
			}
			return prefs;
		}

		function loadPrefs() {
			if (prefsCache) return prefsCache;
			var parsed = null;
			try {
				parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
			} catch (error) {
				parsed = null;
			}
			prefsCache = normalizePrefs(parsed);
			return prefsCache;
		}

		var prefsStore = createStore(loadPrefs());

		function updatePrefs(patch) {
			var current = prefsStore.getSnapshot();
			var next = {
				engine: patch.engine !== undefined ? patch.engine : current.engine,
				lang: patch.lang !== undefined ? normalizeReadingLang(patch.lang) : current.lang,
				autoRead: patch.autoRead !== undefined ? patch.autoRead : current.autoRead,
				skipCode: patch.skipCode !== undefined ? patch.skipCode : current.skipCode,
				rate: patch.rate !== undefined ? clamp(patch.rate, 0.5, 2) : current.rate,
				pitch: patch.pitch !== undefined ? clamp(Math.round(patch.pitch), -20, 20) : current.pitch,
				voices: {
					"pt-BR": current.voices["pt-BR"],
					"en-US": current.voices["en-US"],
				},
			};
			if (patch.voices) {
				if (patch.voices["pt-BR"] !== undefined) next.voices["pt-BR"] = patch.voices["pt-BR"];
				if (patch.voices["en-US"] !== undefined) next.voices["en-US"] = patch.voices["en-US"];
			}
			prefsCache = next;
			prefsStore.set(next);
			try {
				localStorage.setItem(PREFS_KEY, JSON.stringify(next));
			} catch (error) {
				/* private mode: prefs stay in memory */
			}
		}

		function usePrefs() {
			return useSyncExternalStore(prefsStore.subscribe, prefsStore.getSnapshot, prefsStore.getSnapshot);
		}

		// ───────────────────────── text normalization ─────────────────────────
		/**
		 * Convert assistant Markdown into speakable prose.
		 * @param {unknown} input Raw Markdown-ish text.
		 * @param {{skipCode?: boolean}} [options]
		 * @returns {string}
		 */
		function normalizeForSpeech(input, options) {
			var skipCode = !options || options.skipCode !== false;
			var text = typeof input === "string" ? input : "";
			if (text === "") return "";
			text = text.replace(/\r\n?/g, "\n");
			// HTML comments and script/style leftovers never produce speech.
			text = text.replace(/<!--[\s\S]*?-->/g, " ");
			text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
			// Fenced code blocks.
			text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, function (match, body) {
				return skipCode ? " " : "\n" + body + "\n";
			});
			text = text.replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, function (match, body) {
				return skipCode ? " " : "\n" + body + "\n";
			});
			// Inline code keeps its content, loses the backticks.
			text = text.replace(/`([^`\n]+)`/g, "$1");
			// Images: prefer the alt text.
			text = text.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, function (match, alt) {
				return alt && alt.trim() !== "" ? alt : "imagem";
			});
			// Links: spoken text wins; bare links become the word "link".
			text = text.replace(/\[([^\]]+)\]\(([^)]*)\)/g, function (match, label) {
				var clean = String(label).trim();
				return clean !== "" && !/^https?:/i.test(clean) ? clean : "link";
			});
			text = text.replace(/<https?:\/\/[^>\s]+>/gi, "link");
			text = text.replace(/https?:\/\/[^\s)]+/gi, "link");
			// Tables: one sentence per row, cells separated by commas.
			text = text.replace(/(^|\n)([ \t]*\|[^\n]*)(?=\n|$)/g, function (match, prefix, row) {
				var cells = String(row)
					.split("|")
					.map(function (cell) {
						return cell.trim();
					})
					.filter(function (cell, index, all) {
						if (cell === "") return false;
						if (/^:?-{2,}:?$/.test(cell)) return false;
						return !(index === 0 && cell === "" ) && all.length > 0;
					});
				if (cells.length === 0) return prefix;
				return prefix + cells.join(", ") + ".";
			});
			// Lists and blockquotes lose their markers.
			text = text.replace(/^[ \t]*>[ \t]?/gm, "");
			text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "");
			text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
			text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, " ");
			// Emphasis, strikethrough and footnote markers.
			text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
			text = text.replace(/(\*|_)([^\s*_][^*_]*?)\1/g, "$2");
			text = text.replace(/~~([^~]+)~~/g, "$1");
			text = text.replace(/\[\^?[^\]]{1,8}\](?!\()/g, " ");
			// Remaining Markdown noise.
			text = text.replace(/[#>*_|]/g, " ");
			text = text.replace(/\u00a0/g, " ");
			text = text.replace(/[ \t]+/g, " ");
			text = text.replace(/ *\n */g, "\n");
			text = text.replace(/\n{2,}/g, "\n");
			return text.trim();
		}

		/**
		 * Split prose into speakable sentences, each at most `maxChars` long.
		 * @param {unknown} input
		 * @param {number} [maxChars]
		 * @returns {string[]}
		 */
		function splitSentences(input, maxChars) {
			var limit = typeof maxChars === "number" && maxChars >= 80 ? maxChars : MAX_SENTENCE_CHARS;
			var text = typeof input === "string" ? input : "";
			if (text.trim() === "") return [];
			var pieces = text.split(/(?<=[.!?…:;])\s+|\n+/);
			var sentences = [];
			var buffer = "";
			function flush() {
				var clean = buffer.trim();
				if (clean !== "") sentences.push(clean);
				buffer = "";
			}
			for (var i = 0; i < pieces.length; i += 1) {
				var piece = pieces[i].trim();
				if (piece === "") continue;
				if (piece.length > limit) {
					flush();
					var rest = piece;
					while (rest.length > limit) {
						var cut = rest.lastIndexOf(" ", limit);
						if (cut < limit * 0.4) cut = limit;
						var chunk = rest.slice(0, cut).trim();
						if (chunk !== "") sentences.push(chunk);
						rest = rest.slice(cut).trim();
					}
					if (rest !== "") buffer = rest;
					continue;
				}
				var candidate = buffer === "" ? piece : buffer + " " + piece;
				if (candidate.length <= limit) buffer = candidate;
				else {
					flush();
					buffer = piece;
				}
			}
			flush();
			return sentences;
		}

		/**
		 * Cheap language detector used to route a message to the right voice.
		 * @param {unknown} input
		 * @returns {'pt-BR' | 'en-US'}
		 */
		function detectLang(input) {
			var text = typeof input === "string" ? input : "";
			var pt = 0;
			var en = 0;
			if (/[ãõçáéíóúâêôà]/i.test(text)) pt += 2;
			var ptHits = text.match(/\b(que|não|nao|para|com|uma|você|voce|isso|está|esta|aqui|como|mais|também|tambem|porque|então|entao|olá|ola|são|sao|é|obrigado)\b/gi);
			if (ptHits) pt += Math.min(3, ptHits.length);
			var enHits = text.match(/\b(the|and|with|this|that|you|your|for|are|is|of|to|please|thanks|hello|will|from|have)\b/gi);
			if (enHits) en += Math.min(3, enHits.length);
			return pt >= en ? "pt-BR" : "en-US";
		}

		// ───────────────────────── chat text extraction ─────────────────────────
		function blocksToText(blocks) {
			if (!Array.isArray(blocks)) return "";
			var lines = [];
			for (var i = 0; i < blocks.length; i += 1) {
				var block = blocks[i];
				if (!block || block.kind !== "text") continue;
				if (typeof block.text !== "string") continue;
				if (block.text.trim() === "") continue;
				lines.push(block.text);
			}
			return lines.join("\n");
		}

		/**
		 * Defensive assistant-step inspection: never assumes a shape.
		 * @returns {{messageId: string | null, text: string, status: string} | null}
		 */
		function answerFromNode(node) {
			if (!node || node.kind !== "assistant-step") return null;
			var data = node.data;
			if (!isObject(data)) return null;
			var messageId = null;
			if (isObject(data.finalNode) && typeof data.finalNode.messageId === "string") messageId = data.finalNode.messageId;
			else if (typeof data.messageId === "string") messageId = data.messageId;
			var text = blocksToText(data.blocks);
			if (text.trim() === "") return null;
			return { messageId: messageId, text: text, status: typeof data.status === "string" ? data.status : "settled" };
		}

		/**
		 * Walk the nodes of one turn through the defensive snapshot API.
		 * @param {unknown} snapshot
		 * @param {number} turn
		 * @param {(node: unknown) => void} visit
		 */
		function walkTurn(snapshot, turn, visit) {
			var keys = null;
			try {
				keys = snapshot.locations.getTurn(turn);
			} catch (error) {
				keys = null;
			}
			if (!Array.isArray(keys)) return;
			for (var i = 0; i < keys.length; i += 1) {
				var node = null;
				try {
					node = snapshot.nodes.get(keys[i]);
				} catch (error) {
					node = null;
				}
				if (node) visit(node);
			}
		}

		/** @returns {number[]} */
		function turnOrderOf(snapshot) {
			if (!isObject(snapshot)) return [];
			var timeline = snapshot.timeline;
			if (!isObject(timeline) || !Array.isArray(timeline.turnOrder)) return [];
			return timeline.turnOrder.filter(function (turn) {
				return typeof turn === "number";
			});
		}

		/**
		 * Last finalized assistant answer in the snapshot.
		 * @param {unknown} snapshot
		 * @returns {{messageId: string | null, text: string, status: string} | null}
		 */
		function lastAnswerOf(snapshot) {
			var order = turnOrderOf(snapshot);
			for (var t = order.length - 1; t >= 0; t -= 1) {
				var candidates = [];
				walkTurn(snapshot, order[t], function (node) {
					if (!node || node.kind !== "assistant-step") return;
					var answer = answerFromNode(node);
					if (!answer) return;
					if (answer.messageId === null) return;
					if (answer.status === "running") return;
					candidates.push(answer);
				});
				if (candidates.length > 0) return candidates[candidates.length - 1];
			}
			return null;
		}

		/**
		 * One finalized assistant answer by durable message id.
		 * @param {unknown} snapshot
		 * @param {string} messageId
		 * @returns {{messageId: string | null, text: string, status: string} | null}
		 */
		function answerByMessageId(snapshot, messageId) {
			if (typeof messageId !== "string" || messageId === "") return null;
			var order = turnOrderOf(snapshot);
			for (var t = order.length - 1; t >= 0; t -= 1) {
				var found = null;
				walkTurn(snapshot, order[t], function (node) {
					if (found) return;
					if (!node || node.kind !== "assistant-step") return;
					var answer = answerFromNode(node);
					if (answer && answer.messageId === messageId) found = answer;
				});
				if (found) return found;
			}
			return null;
		}

		/** @returns {boolean} Stable equality for a `useChat` selector result. */
		function sameAnswer(left, right) {
			if (left === right) return true;
			if (!left || !right) return false;
			return left.messageId === right.messageId && left.text === right.text && left.status === right.status;
		}

		/**
		 * Last-resort extraction from the rendered DOM (used only when the chat
		 * snapshot source is unavailable). Encapsulated so the fallback cannot
		 * leak into normal flows.
		 * @returns {{messageId: string | null, text: string} | null}
		 */
		function readLastAnswerFromDom() {
			if (typeof document === "undefined") return null;
			try {
				var tails = document.querySelectorAll("[data-turn-tail]");
				if (!tails || tails.length === 0) return null;
				var tail = tails[tails.length - 1];
				var container = tail.parentElement;
				var level = 0;
				while (container && level < 8) {
					if (container.querySelector('[data-slot="conversation.chat.node"], [data-chat-flow-kind]')) break;
					container = container.parentElement;
					level += 1;
				}
				if (!container) container = tail.parentElement;
				if (!container) return null;
				var ignoredTags = { BUTTON: true, SCRIPT: true, STYLE: true, SVG: true, PATH: true, NOSCRIPT: true };
				var ignoredSelectors = [
					'[data-voice-tts-button]',
					'[data-voice-tts-message-button]',
					'[data-slot="conversation.chat.assistant-actions"]',
					'[data-slot="conversation.chat.turnTail"]',
					'[role="toolbar"]',
					'[aria-hidden="true"]',
				];
				function isIgnored(element) {
					if (!element || element.nodeType !== 1) return false;
					if (ignoredTags[element.tagName] === true) return true;
					for (var i = 0; i < ignoredSelectors.length; i += 1) {
						try {
							if (element.matches(ignoredSelectors[i])) return true;
						} catch (error) {
							/* selector unsupported in this engine */
						}
					}
					return false;
				}
				var parts = [];
				function collect(element) {
					if (!element || isIgnored(element)) return;
					for (var child = element.firstChild; child; child = child.nextSibling) {
						if (child.nodeType === 3) {
							var value = String(child.nodeValue || "").trim();
							if (value !== "") parts.push(value);
						} else if (child.nodeType === 1) {
							collect(child);
						}
					}
				}
				var bodies = container.querySelectorAll('[class*="markdown"], [data-markdown], .md');
				if (bodies && bodies.length > 0) {
					for (var b = 0; b < bodies.length; b += 1) collect(bodies[b]);
				} else {
					collect(container);
				}
				var text = parts.join(" ").replace(/\s+/g, " ").trim();
				if (text === "") return null;
				return { messageId: null, text: text };
			} catch (error) {
				return null;
			}
		}

		// ───────────────────────── read marks (auto-read dedupe) ─────────────
		var readMarks = Object.create(null);

		/** @returns {Map<string, number>} */
		function marksFor(sessionId) {
			var key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "global";
			if (readMarks[key]) return readMarks[key];
			var map = new Map();
			try {
				var parsed = JSON.parse(localStorage.getItem(READ_KEY_PREFIX + key) || "null");
				if (isObject(parsed)) {
					Object.keys(parsed).forEach(function (messageId) {
						var at = parsed[messageId];
						if (typeof at === "number" && Date.now() - at < READ_MARK_TTL_MS) map.set(messageId, at);
					});
				}
			} catch (error) {
				/* corrupted mark storage is ignored */
			}
			readMarks[key] = map;
			return map;
		}

		function persistMarks(sessionId, map) {
			var key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "global";
			try {
				var entries = Array.from(map.entries()).slice(-MAX_READ_MARKS);
				var payload = {};
				entries.forEach(function (entry) {
					payload[entry[0]] = entry[1];
				});
				localStorage.setItem(READ_KEY_PREFIX + key, JSON.stringify(payload));
			} catch (error) {
				/* private mode */
			}
		}

		// ───────────────────────── speech controller ─────────────────────────
		var playbackStore = createStore({
			status: "idle",
			messageId: null,
			lang: null,
			engine: null,
			error: null,
			notice: null,
		});

		var controller = {
			generation: 0,
			audio: null,
			urls: new Set(),
			cancelPlay: null,
			noticeTimer: null,
			previewId: "__preview__",
			store: playbackStore,
			setState: function (patch) {
				var current = playbackStore.getSnapshot();
				var next = {
					status: patch.status !== undefined ? patch.status : current.status,
					messageId: patch.messageId !== undefined ? patch.messageId : current.messageId,
					lang: patch.lang !== undefined ? patch.lang : current.lang,
					engine: patch.engine !== undefined ? patch.engine : current.engine,
					error: patch.error !== undefined ? patch.error : current.error,
					notice: patch.notice !== undefined ? patch.notice : current.notice,
				};
				playbackStore.set(next);
			},
			notice: function (key) {
				this.setState({ notice: key });
				if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
				var self = this;
				this.noticeTimer = setTimeout(function () {
					self.noticeTimer = null;
					self.setState({ notice: null });
				}, 9000);
			},
			clearNotice: function () {
				if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
				this.noticeTimer = null;
				this.setState({ notice: null });
			},
			objectUrl: function (base64, mime) {
				var binary = atob(base64);
				var bytes = new Uint8Array(binary.length);
				for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
				var blob = new Blob([bytes], { type: mime || "audio/mpeg" });
				var url = URL.createObjectURL(blob);
				this.urls.add(url);
				return url;
			},
			revoke: function (url) {
				if (!url) return;
				this.urls.delete(url);
				try {
					URL.revokeObjectURL(url);
				} catch (error) {
					/* already revoked */
				}
			},
			/**
			 * Revoke after the current macrotask: a media element that still owns
			 * the URL reports a spurious `ERR_FILE_NOT_FOUND` if the blob is
			 * revoked before its abort settles.
			 */
			revokeSoon: function (url) {
				if (!url) return;
				this.urls.delete(url);
				setTimeout(function () {
					try {
						URL.revokeObjectURL(url);
					} catch (error) {
						/* already revoked */
					}
				}, 0);
			},
			revokeAll: function () {
				var urls = Array.from(this.urls);
				this.urls.clear();
				if (urls.length === 0) return;
				setTimeout(function () {
					urls.forEach(function (url) {
						try {
							URL.revokeObjectURL(url);
						} catch (error) {
							/* already revoked */
						}
					});
				}, 0);
			},
			cancelPlayback: function () {
				this.generation += 1;
				if (typeof this.cancelPlay === "function") {
					try {
						this.cancelPlay();
					} catch (error) {
						/* already finished */
					}
				}
				this.cancelPlay = null;
				if (this.audio) {
					try {
						this.audio.onended = null;
						this.audio.onerror = null;
						this.audio.pause();
						this.audio.removeAttribute("src");
						this.audio.load();
					} catch (error) {
						/* ignore */
					}
					this.audio = null;
				}
				if (typeof window !== "undefined" && window.speechSynthesis) {
					try {
						window.speechSynthesis.cancel();
					} catch (error) {
						/* ignore */
					}
				}
				this.revokeAll();
				if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
				this.noticeTimer = null;
				this.setState({ status: "idle", messageId: null, error: null, notice: null });
			},
			dispose: function () {
				this.cancelPlayback();
			},
		};

		/**
		 * Effective language for one request.
		 *
		 * Precedence: explicit `request.lang` (settings samples) → the persisted
		 * "Reading language" override (`pt-BR`/`en-US`) → automatic detection from
		 * the text. With an override the voice is chosen in that language even when
		 * the text looks like the other one.
		 * @param {{lang?: string}} request
		 * @param {string} text
		 * @returns {'pt-BR' | 'en-US'}
		 */
		function resolveLang(request, text) {
			if (request && (request.lang === "pt-BR" || request.lang === "en-US")) return request.lang;
			var override = prefsStore.getSnapshot().lang;
			if (override === "pt-BR" || override === "en-US") return override;
			return detectLang(text);
		}

		/**
		 * Voice id to send for one engine preference (undefined = engine default).
		 * @param {ReturnType<typeof normalizePrefs>} prefs
		 * @param {'pt-BR' | 'en-US'} lang
		 * @param {string} engine
		 */
		function compatibleVoice(prefs, lang, engine) {
			var voice = prefs.voices[lang];
			if (typeof voice !== "string" || voice === "") return undefined;
			var edge = EDGE_VOICES[lang].indexOf(voice) >= 0;
			var sapi = SAPI_VOICES[lang].indexOf(voice) >= 0;
			if (engine === "edge") return edge ? voice : undefined;
			if (engine === "sapi") return sapi ? voice : undefined;
			if (engine === "browser") return undefined;
			return edge || sapi ? voice : undefined;
		}

		/**
		 * Synthesize one sentence on the host; never rejects (returns a result).
		 * @param {string} sentence
		 * @param {'pt-BR' | 'en-US'} lang
		 */
		async function synthesizeSentence(sentence, lang) {
			var prefs = prefsStore.getSnapshot();
			var engine = prefs.engine === "browser" ? "auto" : prefs.engine;
			var payload = {
				text: sentence,
				lang: lang,
				rate: prefs.rate,
				pitch: prefs.pitch,
				engine: engine,
			};
			var voice = compatibleVoice(prefs, lang, engine);
			if (voice) payload.voice = voice;
			try {
				var value = await callRpc(appCtx, "synthesize", payload);
				return {
					ok: true,
					audioBase64: value.audioBase64,
					mime: value.mime,
					engine: value.engine,
					voice: value.voice,
				};
			} catch (error) {
				return { ok: false, error: error };
			}
		}

		/**
		 * Play one synthesized payload.
		 * @param {number} generation
		 * @param {{audioBase64: string, mime: string}} payload
		 * @returns {Promise<{ok: boolean, blocked?: boolean, cancelled?: boolean}>}
		 */
		function playAudio(generation, payload) {
			return new Promise(function (resolve) {
				if (generation !== controller.generation) {
					resolve({ ok: false, cancelled: true });
					return;
				}
				if (typeof Audio !== "function") {
					resolve({ ok: false });
					return;
				}
				var url = null;
				var audio = null;
				var done = false;
				var durationTimer = null;
				function finish(outcome) {
					if (done) return;
					done = true;
					if (durationTimer !== null) clearTimeout(durationTimer);
					if (controller.cancelPlay === finish) controller.cancelPlay = null;
					if (audio) {
						try {
							audio.onended = null;
							audio.onerror = null;
							audio.pause();
							audio.removeAttribute("src");
							audio.load();
						} catch (error) {
							/* ignore */
						}
					}
					if (controller.audio === audio) controller.audio = null;
					controller.revokeSoon(url);
					resolve(outcome);
				}
				try {
					url = controller.objectUrl(payload.audioBase64, payload.mime);
					audio = new Audio(url);
				} catch (error) {
					finish({ ok: false });
					return;
				}
				controller.audio = audio;
				controller.cancelPlay = finish;
				audio.onended = function () {
					finish({ ok: true });
				};
				audio.onerror = function () {
					finish({ ok: false });
				};
				audio.onloadedmetadata = function () {
					var duration = typeof audio.duration === "number" && Number.isFinite(audio.duration) ? audio.duration : 0;
					if (duration > 0) {
						durationTimer = setTimeout(function () {
							finish({ ok: true });
						}, duration * 1000 + 5000);
					}
				};
				var started = null;
				try {
					started = audio.play();
				} catch (error) {
					finish({ ok: false, blocked: true });
					return;
				}
				if (started && typeof started.then === "function") {
					started.then(null, function (error) {
						var blocked = error && (error.name === "NotAllowedError" || error.name === "SecurityError");
						finish({ ok: false, blocked: Boolean(blocked) });
					});
				}
			});
		}

		/**
		 * Browser `speechSynthesis` fallback for the rest of a queue.
		 * @param {number} generation
		 * @param {string[]} sentences
		 * @param {'pt-BR' | 'en-US'} lang
		 * @returns {Promise<{ok: boolean}>}
		 */
		function speakWithBrowser(generation, sentences, lang) {
			return new Promise(function (resolve) {
				if (typeof window === "undefined" || !window.speechSynthesis) {
					resolve({ ok: false });
					return;
				}
				var synth = window.speechSynthesis;
				var Utterance = window.SpeechSynthesisUtterance;
				if (typeof Utterance !== "function") {
					resolve({ ok: false });
					return;
				}
				var prefs = prefsStore.getSnapshot();
				var voices = [];
				try {
					voices = synth.getVoices() || [];
				} catch (error) {
					voices = [];
				}
				var prefix = lang === "pt-BR" ? "pt" : "en";
				var voice = null;
				for (var i = 0; i < voices.length; i += 1) {
					if (String(voices[i].lang || "").toLowerCase().indexOf(prefix) === 0) {
						voice = voices[i];
						break;
					}
				}
				var index = 0;
				var settled = false;
				function settle(outcome) {
					if (settled) return;
					settled = true;
					resolve(outcome);
				}
				function next() {
					if (generation !== controller.generation) {
						settle({ ok: true });
						return;
					}
					if (index >= sentences.length) {
						settle({ ok: true });
						return;
					}
					var utterance = new Utterance(sentences[index]);
					index += 1;
					utterance.lang = lang;
					utterance.rate = clamp(prefs.rate, 0.5, 2);
					utterance.pitch = clamp(1 + prefs.pitch / 25, 0.5, 1.8);
					utterance.volume = 1;
					if (voice) utterance.voice = voice;
					utterance.onend = next;
					utterance.onerror = function () {
						settle({ ok: false });
					};
					try {
						synth.speak(utterance);
					} catch (error) {
						settle({ ok: false });
					}
				}
				if (voices.length === 0 && typeof synth.addEventListener === "function") {
					var onVoices = function () {
						synth.removeEventListener("voiceschanged", onVoices);
						next();
					};
					synth.addEventListener("voiceschanged", onVoices);
					setTimeout(function () {
						if (settled) return;
						synth.removeEventListener("voiceschanged", onVoices);
						next();
					}, 400);
					return;
				}
				next();
			});
		}

		/** Run the browser-engine path for a whole queue. */
		async function runBrowserQueue(generation, sentences, lang, messageId) {
			controller.setState({ status: "loading", messageId: messageId || null, lang: lang, engine: "browser", error: null });
			var result = await speakWithBrowser(generation, sentences, lang);
			if (generation !== controller.generation) return;
			if (!result.ok) {
				controller.setState({ status: "idle", messageId: null, error: dictT("error.voice") });
				return;
			}
			controller.setState({ status: "idle", messageId: null, engine: null, error: null });
		}

		/** Run the host-engine path with one prefetched sentence. */
		async function runServerQueue(generation, sentences, lang, messageId) {
			var prefetched = null;
			for (var index = 0; index < sentences.length; index += 1) {
				if (generation !== controller.generation) return;
				var current = prefetched || synthesizeSentence(sentences[index], lang);
				prefetched = index + 1 < sentences.length ? synthesizeSentence(sentences[index + 1], lang) : null;
				var result = await current;
				if (generation !== controller.generation) return;
				if (!result.ok) {
					var fallback = await speakWithBrowser(generation, sentences.slice(index), lang);
					if (generation !== controller.generation) return;
					if (fallback.ok) {
						controller.notice("controls.fallback");
						controller.setState({ status: "idle", messageId: null, engine: "browser" });
					} else {
						controller.setState({
							status: "idle",
							messageId: null,
							error: dictT("controls.error", { message: messageOf(result.error) }),
						});
					}
					return;
				}
				if (generation !== controller.generation) return;
				if (controller.store.getSnapshot().status !== "speaking") {
					controller.setState({ status: "speaking", engine: result.engine || null, lang: lang });
				} else if (result.engine && controller.store.getSnapshot().engine !== result.engine) {
					controller.setState({ engine: result.engine });
				}
				var played = await playAudio(generation, result);
				if (generation !== controller.generation) return;
				if (!played.ok) {
					if (played.cancelled) return;
					if (played.blocked) {
						controller.notice("controls.autoplay");
						controller.setState({ status: "idle", messageId: null });
						return;
					}
					var afterFallback = await speakWithBrowser(generation, sentences.slice(index), lang);
					if (generation !== controller.generation) return;
					if (afterFallback.ok) {
						controller.notice("controls.fallback");
						controller.setState({ status: "idle", messageId: null, engine: "browser" });
					} else {
						controller.setState({ status: "idle", messageId: null, error: dictT("error.voice") });
					}
					return;
				}
			}
			if (generation !== controller.generation) return;
			controller.setState({ status: "idle", messageId: null, engine: null, error: null });
		}

		/**
		 * Speak one text. Cancels any current playback first, so two utterances
		 * can never overlap.
		 * @param {{text: string, lang?: string, messageId?: string, preview?: boolean}} request
		 */
		async function speak(request) {
			var prefs = prefsStore.getSnapshot();
			var text = normalizeForSpeech(request && request.text, { skipCode: prefs.skipCode });
			if (text.trim() === "") {
				controller.notice("controls.nothing");
				return;
			}
			var lang = resolveLang(request, text);
			var sentences = splitSentences(text, MAX_SENTENCE_CHARS);
			if (sentences.length === 0) {
				controller.notice("controls.nothing");
				return;
			}
			controller.cancelPlayback();
			var generation = controller.generation;
			var messageId = request && request.messageId ? request.messageId : null;
			controller.setState({ status: "loading", messageId: messageId || (request && request.preview ? controller.previewId : null), lang: lang, error: null });
			if (prefs.engine === "browser") {
				await runBrowserQueue(generation, sentences, lang, messageId);
				return;
			}
			await runServerQueue(generation, sentences, lang, messageId);
		}

		function stop() {
			var hadWork = playbackStore.getSnapshot().status !== "idle";
			controller.cancelPlayback();
			// Stop host-side work too (neural synthesis can be slow); failures are
			// irrelevant here because the client already ignored stale results.
			if (hadWork && appCtx) {
				callRpc(appCtx, "cancel", {}).catch(function () {});
			}
		}

		function usePlayback() {
			return useSyncExternalStore(playbackStore.subscribe, playbackStore.getSnapshot, playbackStore.getSnapshot);
		}

		// ───────────────────────── shared bits ─────────────────────────
		/** Stable no-op used when a component receives no chat selector hook. */
		function useNoChat() {
			return null;
		}

		/** Use the chat snapshot through the framework selector hook (defensive). */
		function useChatSelector(props, selector, equality) {
			var useChat = props && typeof props.useChat === "function" ? props.useChat : useNoChat;
			return useChat(selector, equality);
		}

		function statusLabel(t, playback) {
			if (playback.status === "speaking") return t("controls.speaking");
			if (playback.status === "loading") return t("controls.loading");
			return "";
		}

		// ───────────────────────── composer controls ─────────────────────────
		/**
		 * `conversation.input.left` entry: read/stop the last answer, auto-read
		 * toggle and a subtle speaking indicator.
		 */
		function ComposerTtsControls(props) {
			var ctx = appCtx || {};
			var t = bindT(ctx, props);
			var prefs = usePrefs();
			var playback = usePlayback();
			var sessionId = typeof props.sessionId === "string" ? props.sessionId : null;
			var answer = useChatSelector(props, lastAnswerOf, sameAnswer);
			var baseline = useRef({ sessionId: null, enabled: null });

			// Auto-read: speak a NEW finalized answer once, deduped by messageId.
			useEffect(function () {
				var marks = marksFor(sessionId);
				if (baseline.current.sessionId !== sessionId) {
					baseline.current.sessionId = sessionId;
					baseline.current.enabled = prefs.autoRead;
					if (answer && answer.messageId) {
						marks.set(answer.messageId, Date.now());
						persistMarks(sessionId, marks);
					}
					return;
				}
				if (baseline.current.enabled !== prefs.autoRead) {
					baseline.current.enabled = prefs.autoRead;
					if (prefs.autoRead && answer && answer.messageId) {
						marks.set(answer.messageId, Date.now());
						persistMarks(sessionId, marks);
					}
					return;
				}
				if (!prefs.autoRead) return;
				if (!answer || !answer.messageId || !answer.text) return;
				if (answer.status === "running") return;
				if (marks.has(answer.messageId)) return;
				marks.set(answer.messageId, Date.now());
				persistMarks(sessionId, marks);
				void speak({ text: answer.text, messageId: answer.messageId });
			}, [sessionId, answer && answer.messageId, answer && answer.status, prefs.autoRead]);

			var speakingThis = playback.status !== "idle" && answer && answer.messageId && playback.messageId === answer.messageId;
			var busy = playback.status !== "idle";
			var hasAnswer = Boolean(answer && answer.text);
			var readLabel = busy ? t("controls.stop") : hasAnswer ? t("controls.read") : t("controls.nothing");
			var stateAttr = playback.status === "idle" ? "idle" : playback.status;
			return h(
				"div",
				{
					className: "tts-ctl",
					"data-voice-tts-controls": "",
					"data-voice-tts-state": stateAttr,
				},
				playback.status !== "idle" &&
					h(
						"span",
						{ className: "tts-ctl-status", role: "status", "aria-live": "polite", title: statusLabel(t, playback) },
						playback.status === "loading" ? h(Spinner) : h("span", { className: "tts-dot", "aria-hidden": true }),
						statusLabel(t, playback),
					),
				playback.notice &&
					h(
						"span",
						{ className: "tts-notice", role: "status", "aria-live": "polite" },
						h("span", { className: "tts-notice-text", title: t(playback.notice) }, t(playback.notice)),
						h(
							"button",
							{
								type: "button",
								className: "tts-btn",
								"aria-label": t("controls.retry"),
								title: t("controls.retry"),
								onClick: function () {
									controller.clearNotice();
									if (answer && answer.text) void speak({ text: answer.text, messageId: answer.messageId });
								},
							},
							h(IconPlay),
						),
					),
				h(
					"button",
					{
						type: "button",
						className: "tts-btn",
						"data-voice-tts-button": "",
						"data-state": speakingThis ? "speaking" : "idle",
						"aria-label": readLabel,
						title: readLabel,
						"aria-pressed": busy ? "true" : "false",
						disabled: !busy && !hasAnswer,
						onClick: function () {
							if (busy) {
								stop();
								return;
							}
							if (!hasAnswer) {
								var fromDom = readLastAnswerFromDom();
								if (fromDom && fromDom.text) {
									controller.clearNotice();
									void speak({ text: fromDom.text });
									return;
								}
								controller.notice("controls.nothing");
								return;
							}
							controller.clearNotice();
							void speak({ text: answer.text, messageId: answer.messageId });
						},
					},
					busy ? h(IconStop) : h(IconSpeaker),
				),
				h(
					"button",
					{
						type: "button",
						className: "tts-btn",
						"data-voice-tts-auto": "",
						"data-on": prefs.autoRead ? "on" : "off",
						"aria-label": prefs.autoRead ? t("controls.autoOn") : t("controls.autoOff"),
						title: prefs.autoRead ? t("controls.autoOn") : t("controls.autoOff"),
						"aria-pressed": prefs.autoRead ? "true" : "false",
						onClick: function () {
							updatePrefs({ autoRead: !prefs.autoRead });
						},
					},
					h(IconAuto),
				),
			);
		}

		// ───────────────────────── per-message action ─────────────────────────
		/**
		 * `conversation.chat.assistant-actions` entry: read/stop one finalized
		 * assistant message identified by its durable `messageId`.
		 */
		function AssistantMessageTtsButton(props) {
			var ctx = appCtx || {};
			var t = bindT(ctx, props);
			var playback = usePlayback();
			var messageId = typeof props.messageId === "string" ? props.messageId : "";
			var answer = useChatSelector(
				props,
				function (snapshot) {
					return answerByMessageId(snapshot, messageId);
				},
				sameAnswer,
			);
			if (messageId === "" || !answer || !answer.text) return null;
			var speakingThis = playback.status !== "idle" && playback.messageId === messageId;
			var label = speakingThis ? t("message.stop") : t("message.read");
			return h(
				"button",
				{
					type: "button",
					className: "tts-btn tts-msg-btn",
					"data-voice-tts-message-button": "",
					"data-message-id": messageId,
					"data-state": speakingThis ? "speaking" : playback.status === "loading" && playback.messageId === messageId ? "loading" : "idle",
					"aria-label": label,
					title: label,
					"aria-pressed": speakingThis ? "true" : "false",
					onClick: function () {
						if (speakingThis) {
							stop();
							return;
						}
						controller.clearNotice();
						void speak({ text: answer.text, messageId: messageId });
					},
				},
				speakingThis
					? h(IconStop)
					: playback.status === "loading" && playback.messageId === messageId
						? h(Spinner)
						: h(IconSpeaker),
			);
		}

		// ───────────────────────── settings section ─────────────────────────
		function formatBytes(bytes) {
			var value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
			if (value < 1024) return value + " B";
			if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
			return (value / (1024 * 1024)).toFixed(1) + " MB";
		}

		function phaseText(t, phase) {
			var key = "settings.phase." + phase;
			var text = t(key);
			return text === key ? t("settings.phase.idle") : text;
		}

		function buildVoiceOptions(catalog, lang, t) {
			var options = [h("option", { key: "default", value: "" }, t("settings.voice.default"))];
			var groups = catalog && catalog[lang] && catalog[lang].engines ? catalog[lang].engines : null;
			if (!groups) return options;
			["edge", "sapi"].forEach(function (engine) {
				var voices = Array.isArray(groups[engine]) ? groups[engine] : [];
				if (voices.length === 0) return;
				var children = voices.map(function (voice) {
					var suffix = engine === "sapi" && voice.installed === false ? " " + t("settings.voice.notInstalled") : "";
					return h(
						"option",
						{ key: voice.id, value: voice.id, disabled: engine === "sapi" && voice.installed === false },
						voice.label + suffix,
					);
				});
				options.push(
					h(
						"optgroup",
						{ key: engine, label: engine === "edge" ? t("settings.voice.online") : t("settings.voice.offline") },
						children,
					),
				);
			});
			return options;
		}

		function TtsSettingsSection(props) {
			var ctx = appCtx || {};
			var t = bindT(ctx, props);
			var prefs = usePrefs();
			var playback = usePlayback();
			var [status, setStatus] = useState({ loading: true, value: null, error: null });
			var [prepare, setPrepare] = useState(null);
			var [preparing, setPreparing] = useState(false);
			var [refreshToken, setRefreshToken] = useState(0);
			var pollTimer = useRef(null);
			var alive = useRef(true);

			useEffect(function () {
				alive.current = true;
				return function () {
					alive.current = false;
					if (pollTimer.current !== null) clearTimeout(pollTimer.current);
				};
			}, []);

			useEffect(
				function () {
					var cancelled = false;
					setStatus(function (previous) {
						return { loading: true, value: previous.value, error: null };
					});
					callRpc(ctx, "status", {})
						.then(function (value) {
							if (!cancelled) setStatus({ loading: false, value: value, error: null });
						})
						.catch(function (error) {
							if (!cancelled) setStatus({ loading: false, value: null, error: messageOf(error) });
						});
					return function () {
						cancelled = true;
					};
				},
				[refreshToken],
			);

			function pollPrepare() {
				callRpc(ctx, "prepareStatus", {})
					.then(function (value) {
						if (!alive.current) return;
						setPrepare(value);
						if (value && value.running) {
							pollTimer.current = setTimeout(pollPrepare, 800);
						} else {
							pollTimer.current = null;
							setPreparing(false);
							if (value && value.phase === "ready") setRefreshToken(function (token) { return token + 1; });
						}
					})
					.catch(function (error) {
						if (!alive.current) return;
						pollTimer.current = null;
						setPreparing(false);
						setPrepare({ running: false, phase: "error", progress: 0, message: messageOf(error), error: messageOf(error) });
					});
			}

			function startPrepare() {
				if (preparing) return;
				setPreparing(true);
				setPrepare({ running: true, phase: "check", progress: 0.01, message: t("settings.phase.check"), error: null });
				callRpc(ctx, "prepare", { engine: "edge" })
					.then(function () {
						if (!alive.current) return;
						pollPrepare();
					})
					.catch(function (error) {
						if (!alive.current) return;
						setPreparing(false);
						setPrepare({ running: false, phase: "error", progress: 0, message: messageOf(error), error: messageOf(error) });
					});
			}

			function playSample(lang) {
				controller.clearNotice();
				void speak({ text: SAMPLE_TEXT[lang], lang: lang, preview: true });
			}

			var statusValue = status.value;
			var catalog = statusValue && statusValue.voices ? statusValue.voices : null;
			var edge = statusValue && statusValue.engines ? statusValue.engines.edge : null;
			var sapi = statusValue && statusValue.engines ? statusValue.engines.sapi : null;
			var cache = statusValue && statusValue.cache ? statusValue.cache : null;
			var edgeReady = Boolean(edge && edge.prepared);
			var sapiReady = Boolean(sapi && sapi.available);
			var phase = prepare && prepare.phase ? prepare.phase : edgeReady ? "ready" : "idle";
			var progress = prepare && typeof prepare.progress === "number" ? clamp(prepare.progress, 0, 1) : edgeReady ? 1 : 0;
			var sapiVoiceCount = sapi && Array.isArray(sapi.voices) ? sapi.voices.length : 0;
			var uiLang = t("settings.test") === dict.pt["settings.test"] ? "pt-BR" : "en-US";
			// "Testar" follows the fixed reading language when one is chosen;
			// automatic falls back to the GUI language.
			var testLang = prefs.lang === "auto" ? uiLang : prefs.lang;
			return h(
				"div",
				{ className: "tts-settings", "data-voice-tts-settings": "" },
				h(
					"div",
					{ className: "tts-settings-head" },
					h("div", { className: "tts-settings-title" }, t("settings.title")),
					h("div", { className: "tts-settings-sub" }, t("settings.subtitle")),
				),
				h(
					"div",
					{ className: "tts-card" },
					h("div", { className: "tts-card-title" }, t("settings.engine")),
					h(
						"div",
						{ className: "tts-row" },
						h(
							"div",
							{ className: "tts-row-text" },
							h("div", { className: "tts-row-label" }, t("settings.engine")),
							h("div", { className: "tts-row-hint" }, t("settings.engine.hint")),
						),
						h(
							"select",
							{
								className: "tts-select",
								"aria-label": t("settings.engine"),
								value: prefs.engine,
								onChange: function (event) {
									updatePrefs({ engine: event.target.value });
								},
							},
							h("option", { value: "auto" }, t("settings.engine.auto")),
							h("option", { value: "edge" }, t("settings.engine.edge")),
							h("option", { value: "sapi" }, t("settings.engine.sapi")),
							h("option", { value: "browser" }, t("settings.engine.browser")),
						),
					),
					h(
						"div",
						{ className: "tts-row" },
						h(
							"div",
							{ className: "tts-row-text" },
							h("div", { className: "tts-row-label" }, t("settings.lang")),
							h("div", { className: "tts-row-hint" }, t("settings.lang.hint")),
						),
						h(
							"select",
							{
								className: "tts-select",
								"data-voice-tts-lang": "",
								"aria-label": t("settings.lang"),
								value: prefs.lang,
								onChange: function (event) {
									updatePrefs({ lang: event.target.value });
								},
							},
							h("option", { value: "auto" }, t("settings.lang.auto")),
							h("option", { value: "pt-BR" }, t("settings.lang.pt")),
							h("option", { value: "en-US" }, t("settings.lang.en")),
						),
					),
					h(
						"div",
						{ className: "tts-row" },
						h("div", { className: "tts-row-label" }, t("settings.voicePt")),
						h(
							"div",
							{ className: "tts-samples" },
							h(
								"select",
								{
									className: "tts-select",
									"aria-label": t("settings.voicePt"),
									value: prefs.voices["pt-BR"] || "",
									onChange: function (event) {
										updatePrefs({ voices: { "pt-BR": event.target.value || null } });
									},
								},
								buildVoiceOptions(catalog, "pt-BR", t),
							),
							h(
								"button",
								{
									type: "button",
									className: "tts-btn-ghost",
									title: t("settings.sample"),
									"aria-label": t("settings.sample"),
									onClick: function () {
										playSample("pt-BR");
									},
								},
								h(IconPlay),
							),
						),
					),
					h(
						"div",
						{ className: "tts-row" },
						h("div", { className: "tts-row-label" }, t("settings.voiceEn")),
						h(
							"div",
							{ className: "tts-samples" },
							h(
								"select",
								{
									className: "tts-select",
									"aria-label": t("settings.voiceEn"),
									value: prefs.voices["en-US"] || "",
									onChange: function (event) {
										updatePrefs({ voices: { "en-US": event.target.value || null } });
									},
								},
								buildVoiceOptions(catalog, "en-US", t),
							),
							h(
								"button",
								{
									type: "button",
									className: "tts-btn-ghost",
									title: t("settings.sample"),
									"aria-label": t("settings.sample"),
									onClick: function () {
										playSample("en-US");
									},
								},
								h(IconPlay),
							),
						),
					),
					h(
						"div",
						{ className: "tts-row" },
						h("div", { className: "tts-row-label" }, t("settings.rate")),
						h(
							"div",
							{ className: "tts-slider" },
							h("input", {
								type: "range",
								min: 0.5,
								max: 2,
								step: 0.05,
								value: prefs.rate,
								"aria-label": t("settings.rate"),
								onChange: function (event) {
									updatePrefs({ rate: Number(event.target.value) });
								},
							}),
							h("span", { className: "tts-slider-value" }, prefs.rate.toFixed(2) + "×"),
						),
					),
					h(
						"div",
						{ className: "tts-row" },
						h(
							"div",
							{ className: "tts-row-text" },
							h("div", { className: "tts-row-label" }, t("settings.pitch")),
							prefs.engine === "sapi" && h("div", { className: "tts-row-hint" }, t("settings.pitchUnsupported")),
						),
						h(
							"div",
							{ className: "tts-slider" },
							h("input", {
								type: "range",
								min: -20,
								max: 20,
								step: 1,
								value: prefs.pitch,
								disabled: prefs.engine === "sapi" || prefs.engine === "browser",
								"aria-label": t("settings.pitch"),
								onChange: function (event) {
									updatePrefs({ pitch: Number(event.target.value) });
								},
							}),
							h("span", { className: "tts-slider-value" }, (prefs.pitch > 0 ? "+" : "") + prefs.pitch + " Hz"),
						),
					),
					h(
						"label",
						{ className: "tts-check" },
						h("input", {
							type: "checkbox",
							checked: prefs.autoRead,
							onChange: function (event) {
								updatePrefs({ autoRead: event.target.checked });
							},
						}),
						h("span", null, t("settings.autoRead")),
					),
					h(
						"label",
						{ className: "tts-check" },
						h("input", {
							type: "checkbox",
							checked: prefs.skipCode,
							onChange: function (event) {
								updatePrefs({ skipCode: event.target.checked });
							},
						}),
						h("span", null, t("settings.skipCode")),
					),
				),
				h(
					"div",
					{ className: "tts-card" },
					h("div", { className: "tts-card-title" }, t("settings.runtime")),
					status.loading && !statusValue
						? h("div", { className: "tts-phase" }, h(Spinner), phaseText(t, "check"))
						: null,
					status.error ? h("div", { className: "tts-error", role: "alert" }, status.error) : null,
					h(
						"div",
						{ className: "tts-checks" },
						h(
							"div",
							{ className: "tts-check-row" },
							edgeReady ? h("span", { className: "tts-ok" }, h(IconCheck)) : h("span", { className: "tts-bad" }, h(IconCross)),
							h("span", null, t("settings.runtime.edge")),
							h(
								"span",
								{ className: "tts-check-detail" },
								edgeReady ? t("settings.runtime.ready") : t("settings.runtime.notReady"),
							),
						),
						h(
							"div",
							{ className: "tts-check-row" },
							sapiReady ? h("span", { className: "tts-ok" }, h(IconCheck)) : h("span", { className: "tts-bad" }, h(IconCross)),
							h("span", null, t("settings.runtime.sapi")),
							h(
								"span",
								{ className: "tts-check-detail" },
								sapiReady
									? t("settings.runtime.voices", { count: sapiVoiceCount })
									: t("settings.runtime.unavailable"),
							),
						),
						h(
							"div",
							{ className: "tts-check-row" },
							h("span", { className: "tts-ok" }, h(IconCheck)),
							h("span", null, t("settings.runtime.browser")),
							h("span", { className: "tts-check-detail" }, t("settings.runtime.available")),
						),
						edge && edge.python
							? h(
									"div",
									{ className: "tts-check-row" },
									h("span", { className: "tts-muted" }, h(IconSpeaker, { waves: false })),
									h(
										"span",
										null,
										edge.python.found
											? t("settings.runtime.python", { version: edge.python.version })
											: t("settings.runtime.noPython"),
									),
								)
							: null,
					),
					h(
						"div",
						{ className: "tts-progress" },
						h("div", { className: "tts-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(progress * 100) },
							h("div", { className: "tts-bar-fill", style: { width: Math.round(progress * 100) + "%" } }),
						),
						h(
							"div",
							{ className: "tts-phase" },
							preparing ? h(Spinner) : null,
							phaseText(t, phase),
							prepare && prepare.error ? h("span", { className: "tts-error" }, prepare.error) : null,
						),
					),
					h(
						"div",
						{ className: "tts-row" },
						h("div", { className: "tts-row-hint" }, t("settings.prepare.hint")),
						h(
							"div",
							{ className: "tts-samples" },
							h(
								"button",
								{
									type: "button",
									className: "tts-btn-ghost",
									title: t("settings.refresh"),
									"aria-label": t("settings.refresh"),
									onClick: function () {
										setRefreshToken(function (token) {
											return token + 1;
										});
									},
								},
								h(IconRefresh),
							),
							h(
								"button",
								{
									type: "button",
									className: "tts-btn-primary",
									disabled: preparing || edgeReady,
									onClick: startPrepare,
								},
								preparing ? h(Spinner) : null,
								preparing ? t("settings.prepare.running") : t("settings.prepare"),
							),
							h(
								"button",
								{
									type: "button",
									className: "tts-btn-ghost",
									onClick: function () {
										controller.clearNotice();
										void speak({ text: SAMPLE_TEXT[testLang], lang: testLang, preview: true });
									},
								},
								h(IconSpeaker),
								t("settings.test"),
							),
						),
					),
				),
				h(
					"div",
					{ className: "tts-card" },
					h(
						"div",
						{ className: "tts-row" },
						h("div", { className: "tts-row-label" }, t("settings.cache")),
						h(
							"span",
							{ className: "tts-row-hint" },
							cache
								? cache.files > 0
									? t("settings.cache.value", { files: cache.files, size: formatBytes(cache.bytes) })
									: t("settings.cache.empty")
								: "—",
						),
					),
					h("div", { className: "tts-hint" }, t("settings.privacy")),
				),
				playback.error ? h("div", { className: "tts-error", role: "alert" }, playback.error) : null,
			);
		}

		// ───────────────────────── plugin body ─────────────────────────
		function installDebugHook() {
			if (typeof window === "undefined") return;
			var namespace = window.__dshVoiceDebug;
			if (!namespace || typeof namespace !== "object") namespace = {};
			namespace.tts = {
				plugin: "tts",
				version: VERSION,
				rpc: function (endpoint, payload) {
					return callRpc(appCtx, endpoint, payload);
				},
				state: function () {
					return playbackStore.getSnapshot();
				},
				stop: function () {
					stop();
				},
				speak: function (text, lang) {
					return speak({ text: text, lang: lang });
				},
			};
			window.__dshVoiceDebug = namespace;
		}

		/**
		 * Register one slot contribution defensively: `slots.inject` waits for a
		 * dynamically declared slot; registration happens inside `ctx.effect`.
		 */
		function registerSlot(ctx, slotName, effectLabel, options, component) {
			return ctx.effect(function () {
				var register = function () {
					return ctx.slots.register(options, component);
				};
				if (typeof ctx.slots.inject === "function") return ctx.slots.inject(slotName, register);
				return register();
			}, effectLabel);
		}

		function apply(ctx) {
			appCtx = ctx;
			installDebugHook();
			ctx.effect(function () {
				return claimStyles();
			}, "dsh-tts: styles");
			ctx.effect(function () {
				return ctx.locale.register(NS, dict);
			}, "dsh-tts: dictionaries");
			registerSlot(
				ctx,
				"conversation.input.left",
				"dsh-tts: composer controls",
				{ name: "conversation.input.left", id: "tts", order: 20, locale: NS },
				ComposerTtsControls,
			);
			registerSlot(
				ctx,
				"conversation.chat.assistant-actions",
				"dsh-tts: message actions",
				{ name: "conversation.chat.assistant-actions", id: "tts", order: 20, locale: NS },
				AssistantMessageTtsButton,
			);
			registerSlot(ctx, "settings.section", "dsh-tts: settings section", {
				name: "settings.section",
				id: "voice-tts",
				order: 45,
				label: function () {
					try {
						return ctx.locale.bind(NS)("settings.nav");
					} catch (error) {
						return dictT("settings.nav");
					}
				},
				locale: NS,
			}, TtsSettingsSection);
			ctx.effect(function () {
				return function () {
					controller.dispose();
				};
			}, "dsh-tts: speech controller");
		}

		exports.apply = apply;
		// Chat text comes from the framework `useChat` standard prop (§3.6); the
		// session binding is not needed by this client half.
		exports.inject = ["slots", "locale", "connection", "sessions"];
		/**
		 * Pure helpers exported for unit tests (not part of the client contract).
		 */
		exports.__test = Object.freeze({
			normalizeForSpeech: normalizeForSpeech,
			splitSentences: splitSentences,
			detectLang: detectLang,
			normalizePrefs: normalizePrefs,
			normalizeReadingLang: normalizeReadingLang,
			resolveLang: resolveLang,
			updatePrefs: updatePrefs,
			DEFAULT_PREFS: DEFAULT_PREFS,
			READING_LANGS: READING_LANGS,
			lastAnswerOf: lastAnswerOf,
			answerByMessageId: answerByMessageId,
			blocksToText: blocksToText,
			readLastAnswerFromDom: readLastAnswerFromDom,
			compatibleVoice: compatibleVoice,
			sameAnswer: sameAnswer,
			dict: dict,
			CSS: CSS,
			PREFS_KEY: PREFS_KEY,
		});
		return module.exports;
	},
});
