/**
 * dsh-whisper-stt — client half.
 *
 * Hand-written DSH client-module bundle (no build step):
 *   window.__ModuleLoader__.load({ id: "dsh-whisper-stt", factory })
 *
 * The factory requires only `react`; every other capability comes from the
 * client runtime services handed to apply(ctx): slots, locale, connection,
 * sessions.
 *
 * Contributions:
 *   - `conversation.input.activity` (kind single, session scope): the dictation
 *     microphone. States idle → requesting → recording → transcribing, live RMS
 *     meter written straight to CSS custom properties (no re-render per frame),
 *     mm:ss timer, Auto/pt-BR/en-US language popover, Esc cancels, errors as an
 *     inline actionable toast ("Preparar modelo"). Text is inserted through
 *     `inputActions.insertText(text, span)` with `setDraft` as the fallback.
 *   - `settings.section` (id `voice-stt`): runtime checks, model/language/device
 *     preferences, preparation with phase + progress bar, and a microphone test
 *     that records ~4 s and transcribes it for real.
 *
 * Contracts honoured: all styling uses `--dsw-*` tokens only (no hardcoded
 * colors), pt-BR first with en-US fallback, prefs in localStorage
 * `dsh-whisper-stt.prefs`, and the diagnostic hook
 * `window.__dshVoiceDebug.stt = { plugin, version, rpc }` installed by apply().
 */
window.__ModuleLoader__.load({
	id: "dsh-whisper-stt",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const useState = React.useState;
		const useEffect = React.useEffect;
		const useRef = React.useRef;
		const useCallback = React.useCallback;
		const useMemo = React.useMemo;

		// ───────────────────────── constants ─────────────────────────
		const NS = "whisper-stt";
		const VERSION = "1.0.0";
		const PREFS_KEY = "dsh-whisper-stt.prefs";
		const CHANNEL = "/voice-stt";
		const PLUGIN_ID = "whisper-stt";
		const MODELS = ["tiny", "base", "small", "medium", "large-v3"];
		const LANGUAGES = [
			["auto", "dictate.langAuto"],
			["pt", "dictate.langPt"],
			["en", "dictate.langEn"],
		];
		const MAX_SECONDS_HARD = 120;

		/** Context captured by apply(); components read it directly. */
		var appCtx = null;

		// ───────────────────────── helpers ─────────────────────────
		/** Create an element without JSX (flattens child arrays so React keeps keys). */
		function h(tag, props) {
			const children = [];
			for (let index = 2; index < arguments.length; index += 1) {
				const child = arguments[index];
				if (Array.isArray(child)) {
					for (const nested of child) children.push(nested);
				} else {
					children.push(child);
				}
			}
			return children.length > 0 ? React.createElement(tag, props, ...children) : React.createElement(tag, props);
		}
		/** Join truthy class names. */
		function cx() {
			var out = [];
			for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
			return out.join(" ");
		}
		function noop() {}
		/** Promise-based delay used by the preparation poller and test recorder. */
		function delay(ms) {
			return new Promise(function (resolve) {
				setTimeout(resolve, ms);
			});
		}
		/** Format seconds as mm:ss. */
		function formatMmSs(seconds) {
			var total = Math.max(0, Math.floor(seconds));
			var minutes = Math.floor(total / 60);
			var rest = total % 60;
			return String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
		}
		/** Extract a human message from an unknown rejection. */
		function messageOf(error) {
			return error && error.message ? String(error.message) : String(error);
		}

		// ───────────────────────── i18n ─────────────────────────
		const dict = {
			pt: {
				"settings.nav": "Ditado por voz",
				"settings.title": "Ditado por voz (Whisper)",
				"settings.intro":
					"Transcrição local com faster-whisper. O áudio é processado nesta máquina e nunca é enviado para a nuvem; a única rede usada é o download do modelo a partir do HuggingFace.",
				"settings.runtime": "Runtime",
				"settings.checks": "Verificações",
				"settings.refresh": "Atualizar status",
				"settings.check.python": "Python",
				"settings.check.venv": "Ambiente virtual (venv)",
				"settings.check.faster-whisper": "faster-whisper",
				"settings.check.model": "Modelo",
				"settings.check.cuda": "GPU / CUDA",
				"settings.model": "Modelo",
				"settings.language": "Idioma padrão",
				"settings.device": "Dispositivo",
				"settings.deviceAuto": "Automático (GPU → CPU)",
				"settings.deviceCuda": "GPU (CUDA)",
				"settings.deviceCpu": "CPU",
				"settings.cudaLibs": "Bibliotecas CUDA (cuBLAS)",
				"settings.cudaLibsAuto": "Instalar automaticamente (GPU)",
				"settings.cudaLibsOff": "Nunca instalar (CPU)",
				"settings.maxSeconds": "Duração máxima (s)",
				"settings.idle": "Descarregar modelo após (min)",
				"settings.saveError": "Falha ao salvar: {message}",
				"settings.prepare": "Preparar / baixar modelo",
				"settings.reprepare": "Repreparar",
				"settings.cancel": "Cancelar",
				"settings.ready": "Pronto para ditar.",
				"settings.notReady": "Runtime incompleto — clique em Preparar.",
				"settings.workerIdle": "Worker ocioso (modelo não carregado)",
				"settings.runtimeDevice": "Dispositivo em uso: {device} ({computeType})",
				"settings.test": "Testar microfone",
				"settings.testHint": "Grava ~4 s e transcreve para validar o runtime.",
				"settings.testRecording": "Gravando teste… fale algo.",
				"settings.testTranscribing": "Transcrevendo teste…",
				"settings.testResult": "Resultado: “{text}” ({ms} ms, {device})",
				"settings.testEmpty": "Nada foi transcrito.",
				"settings.testFailed": "Teste falhou: {message}",
				"settings.phase.venv": "Criando ambiente Python",
				"settings.phase.pip": "Instalando dependências",
				"settings.phase.model": "Baixando modelo",
				"settings.phase.load": "Carregando modelo",
				"settings.phase.ready": "Pronto",
				"settings.phase.error": "Erro",
				"settings.phase.idle": "Ocioso",
				"settings.phaseHint": "{phase} — {progress}%",
				"settings.paths": "Caminhos",
				"settings.pathsHome": "Home do runtime: {home}",
				"settings.pathsLogs": "Logs: {logs}",
				"settings.privacy": "Privacidade: o áudio permanece nesta máquina.",
				"dictate.group": "Ditado por voz",
				"dictate.start": "Ditar por voz",
				"dictate.stop": "Parar e transcrever",
				"dictate.cancel": "Cancelar ditado",
				"dictate.discard": "Descartar gravação",
				"dictate.requesting": "Solicitando microfone…",
				"dictate.recording": "Gravando…",
				"dictate.transcribing": "Transcrevendo…",
				"dictate.language": "Idioma do ditado",
				"dictate.langAuto": "Auto",
				"dictate.langPt": "Português (BR)",
				"dictate.langEn": "Inglês (US)",
				"dictate.empty": "Nenhuma fala detectada. Tente novamente.",
				"dictate.tooLarge": "Áudio muito longo (máximo {seconds}s).",
				"dictate.setupRequired": "Runtime de transcrição incompleto. Baixe o modelo para ditar.",
				"dictate.actionPrepare": "Preparar",
				"dictate.actionRetry": "Tentar novamente",
				"dictate.dismiss": "Dispensar",
				"dictate.preparing": "Preparando: {phase} ({progress}%)",
				"dictate.prepareDone": "Runtime pronto. Clique no microfone para ditar.",
				"dictate.prepareFailed": "Falha ao preparar: {message}",
				"dictate.cancelled": "Preparação cancelada.",
				"dictate.error": "Falha na transcrição: {message}",
				"dictate.insertFailed": "Não foi possível inserir o texto no campo de mensagem.",
				"dictate.noComposer": "Campo de mensagem indisponível.",
				"dictate.micPermission": "Acesso ao microfone negado. Permita o microfone no navegador.",
				"dictate.micMissing": "Nenhum microfone encontrado.",
				"dictate.micUnavailable": "Este navegador não permite gravar áudio.",
				"dictate.micInterrupted": "O microfone foi interrompido.",
				"dictate.micEmpty": "Gravação vazia.",
				"dictate.micFailed": "Falha na captura de áudio: {message}",
				"common.loading": "Carregando…",
				"common.close": "Fechar",
			},
			en: {
				"settings.nav": "Voice dictation",
				"settings.title": "Voice dictation (Whisper)",
				"settings.intro":
					"Local transcription with faster-whisper. Audio is processed on this machine and never sent to the cloud; the only network use is the one-time model download from HuggingFace.",
				"settings.runtime": "Runtime",
				"settings.checks": "Checks",
				"settings.refresh": "Refresh status",
				"settings.check.python": "Python",
				"settings.check.venv": "Virtual environment (venv)",
				"settings.check.faster-whisper": "faster-whisper",
				"settings.check.model": "Model",
				"settings.check.cuda": "GPU / CUDA",
				"settings.model": "Model",
				"settings.language": "Default language",
				"settings.device": "Device",
				"settings.deviceAuto": "Automatic (GPU → CPU)",
				"settings.deviceCuda": "GPU (CUDA)",
				"settings.deviceCpu": "CPU",
				"settings.cudaLibs": "CUDA libraries (cuBLAS)",
				"settings.cudaLibsAuto": "Install automatically (GPU)",
				"settings.cudaLibsOff": "Never install (CPU)",
				"settings.maxSeconds": "Max duration (s)",
				"settings.idle": "Unload model after (min)",
				"settings.saveError": "Could not save: {message}",
				"settings.prepare": "Prepare / download model",
				"settings.reprepare": "Prepare again",
				"settings.cancel": "Cancel",
				"settings.ready": "Ready to dictate.",
				"settings.notReady": "Runtime incomplete — click Prepare.",
				"settings.workerIdle": "Worker idle (model not loaded)",
				"settings.runtimeDevice": "Device in use: {device} ({computeType})",
				"settings.test": "Test microphone",
				"settings.testHint": "Records ~4 s and transcribes it to validate the runtime.",
				"settings.testRecording": "Recording test… speak now.",
				"settings.testTranscribing": "Transcribing test…",
				"settings.testResult": "Result: “{text}” ({ms} ms, {device})",
				"settings.testEmpty": "Nothing was transcribed.",
				"settings.testFailed": "Test failed: {message}",
				"settings.phase.venv": "Creating Python environment",
				"settings.phase.pip": "Installing dependencies",
				"settings.phase.model": "Downloading model",
				"settings.phase.load": "Loading model",
				"settings.phase.ready": "Ready",
				"settings.phase.error": "Error",
				"settings.phase.idle": "Idle",
				"settings.phaseHint": "{phase} — {progress}%",
				"settings.paths": "Paths",
				"settings.pathsHome": "Runtime home: {home}",
				"settings.pathsLogs": "Logs: {logs}",
				"settings.privacy": "Privacy: audio stays on this machine.",
				"dictate.group": "Voice dictation",
				"dictate.start": "Dictate",
				"dictate.stop": "Stop and transcribe",
				"dictate.cancel": "Cancel dictation",
				"dictate.discard": "Discard recording",
				"dictate.requesting": "Requesting microphone…",
				"dictate.recording": "Recording…",
				"dictate.transcribing": "Transcribing…",
				"dictate.language": "Dictation language",
				"dictate.langAuto": "Auto",
				"dictate.langPt": "Portuguese (BR)",
				"dictate.langEn": "English (US)",
				"dictate.empty": "No speech detected. Try again.",
				"dictate.tooLarge": "Audio too long (max {seconds}s).",
				"dictate.setupRequired": "Transcription runtime incomplete. Download the model to dictate.",
				"dictate.actionPrepare": "Prepare",
				"dictate.actionRetry": "Try again",
				"dictate.dismiss": "Dismiss",
				"dictate.preparing": "Preparing: {phase} ({progress}%)",
				"dictate.prepareDone": "Runtime ready. Click the microphone to dictate.",
				"dictate.prepareFailed": "Preparation failed: {message}",
				"dictate.cancelled": "Preparation cancelled.",
				"dictate.error": "Transcription failed: {message}",
				"dictate.insertFailed": "Could not insert the text into the message field.",
				"dictate.noComposer": "Message field unavailable.",
				"dictate.micPermission": "Microphone access denied. Allow the microphone in your browser.",
				"dictate.micMissing": "No microphone found.",
				"dictate.micUnavailable": "This browser cannot record audio.",
				"dictate.micInterrupted": "The microphone was interrupted.",
				"dictate.micEmpty": "Empty recording.",
				"dictate.micFailed": "Audio capture failed: {message}",
				"common.loading": "Loading…",
				"common.close": "Close",
			},
		};

		/**
		 * Dictionary fallback used when the host does not inject `t`.
		 * Portuguese is the authoring language; English is the secondary.
		 */
		function dictT(key, vars) {
			var table = dict.pt || {};
			var tableEn = dict.en || {};
			var text = table[key] != null ? table[key] : tableEn[key] != null ? tableEn[key] : key;
			if (vars) {
				text = String(text).replace(/\{(\w+)\}/g, function (match, name) {
					return vars[name] != null ? String(vars[name]) : match;
				});
			}
			return text;
		}

		/** Resolve the active translator, degrading to the local dictionary. */
		function bindT(ctx, props) {
			if (props && typeof props.t === "function") return props.t;
			try {
				if (ctx && ctx.locale && typeof ctx.locale.bind === "function") {
					var bound = ctx.locale.bind(NS);
					if (typeof bound === "function") return bound;
				}
			} catch (error) {
				/* locale service unavailable: use the dictionary */
			}
			return dictT;
		}

		// ───────────────────────── rpc ─────────────────────────
		/** Translate one rejection into an Error carrying the RPC code. */
		function rpcError(error) {
			var out = new Error((error && error.message) || "erro de comunicação");
			out.code = error && error.code;
			return out;
		}
		/** Call one `/voice-stt` endpoint and unwrap the RPC envelope. */
		async function callRpc(ctx, endpoint, payload) {
			var connection = ctx && ctx.connection;
			if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") {
				throw rpcError({ message: "serviço de conexão indisponível", code: "internal" });
			}
			var result = await connection.rpc.call(CHANNEL, endpoint, payload || {});
			if (!result || result.ok !== true) throw rpcError(result && result.error);
			return result.value;
		}

		// ───────────────────────── preferences ─────────────────────────
		var prefsCache = null;
		/** Load the prefs object once; never re-parse per action. */
		function loadPrefs() {
			if (prefsCache) return prefsCache;
			var stored = {};
			try {
				stored = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
			} catch (error) {
				stored = {};
			}
			if (!stored || typeof stored !== "object") stored = {};
			if (typeof stored.language !== "string") stored.language = "auto";
			prefsCache = stored;
			return prefsCache;
		}
		/** Persist the whole prefs object (single writer). */
		function savePrefs(next) {
			prefsCache = next;
			try {
				localStorage.setItem(PREFS_KEY, JSON.stringify(next));
			} catch (error) {
				/* private mode: keep the in-memory cache */
			}
		}

		// ───────────────────────── status cache ─────────────────────────
		var statusCache = { ctx: null, at: 0, value: null };
		/**
		 * Fetch `/voice-stt/status`, reusing a short-lived cache.
		 * @param {any} ctx client context
		 * @param {number} [maxAgeMs] freshness window
		 */
		async function getStatus(ctx, maxAgeMs) {
			var age = statusCache.value ? Date.now() - statusCache.at : Infinity;
			if (statusCache.ctx === ctx && statusCache.value && age < (maxAgeMs == null ? 15000 : maxAgeMs)) return statusCache.value;
			var value = await callRpc(ctx, "status", {});
			statusCache = { ctx: ctx, at: Date.now(), value: value };
			return value;
		}
		/** Drop the status cache (after prepare/config changes). */
		function invalidateStatus() {
			statusCache = { ctx: null, at: 0, value: null };
		}

		// ───────────────────────── preparation flow ─────────────────────────
		/**
		 * Start preparation and poll `prepareStatus` until a terminal phase.
		 * @param {any} ctx client context
		 * @param {(snapshot: any) => void} [onUpdate] progress callback
		 * @returns {Promise<any>} terminal prepare snapshot
		 */
		async function startPreparation(ctx, onUpdate) {
			await callRpc(ctx, "prepare", {});
			for (var attempt = 0; attempt < 1800; attempt++) {
				var snapshot = await callRpc(ctx, "prepareStatus", {});
				if (typeof onUpdate === "function") {
					try {
						onUpdate(snapshot);
					} catch (error) {
						/* render callbacks must not break polling */
					}
				}
				if (snapshot.phase === "ready" || snapshot.phase === "error" || snapshot.phase === "idle") return snapshot;
				await delay(800);
			}
			throw new Error("tempo esgotado aguardando a preparação do runtime");
		}

		// ───────────────────────── audio capture ─────────────────────────
		/** Capture failure whose message is localized by the caller. */
		class RecordingError extends Error {
			constructor(kind) {
				super(kind);
				this.kind = kind;
				this.name = "RecordingError";
			}
		}

		/**
		 * Encode mono float samples as the PCM16 WAV the host accepts.
		 * @param {Float32Array} samples 16 kHz mono samples
		 * @returns {Uint8Array} complete little-endian WAV bytes
		 */
		function encodeWave(samples) {
			const bytes = new Uint8Array(44 + samples.length * 2);
			const view = new DataView(bytes.buffer);
			const text = (at, value) => {
				for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
			};
			text(0, "RIFF");
			view.setUint32(4, bytes.length - 8, true);
			text(8, "WAVE");
			text(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, 16000, true);
			view.setUint32(28, 32000, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			text(36, "data");
			view.setUint32(40, samples.length * 2, true);
			for (let i = 0; i < samples.length; i++) {
				const value = Math.max(-1, Math.min(1, samples[i]));
				view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
			}
			return bytes;
		}

		/** Base64-encode WAV bytes (chunked to avoid stack limits). */
		function audioBase64(bytes) {
			let text = "";
			for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
			return btoa(text);
		}

		/**
		 * One microphone acquisition: permission prompt, MediaRecorder capture,
		 * native Web Audio resampling to 16 kHz, WAV encoding on stop.
		 * Mirrors the DSH voice-input recording lifecycle.
		 */
		class Recording {
			constructor(onDispose) {
				this.onDispose = typeof onDispose === "function" ? onDispose : noop;
				this.stream = null;
				this.recorder = null;
				this.context = null;
				this.analyser = null;
				this.samples = new Float32Array(256);
				this.chunks = [];
				this.lifetime = new AbortController();
				this.disposal = null;
			}

			/** Acquire the microphone and start the level analyser. */
			async preview(onError) {
				const devices = navigator.mediaDevices;
				if (!devices || typeof devices.getUserMedia !== "function") throw new RecordingError("unavailable");
				let stream;
				try {
					stream = await devices.getUserMedia({
						audio: { echoCancellation: true, noiseSuppression: true },
						video: false,
					});
				} catch (error) {
					if (error instanceof DOMException) {
						if (error.name === "NotAllowedError") throw new RecordingError("permission");
						if (error.name === "NotFoundError" || error.name === "OverconstrainedError") throw new RecordingError("deviceMissing");
					}
					throw new RecordingError("failed:" + messageOf(error));
				}
				if (this.lifetime.signal.aborted) {
					stream.getTracks().forEach((track) => track.stop());
					throw new RecordingError("cancelled");
				}
				this.stream = stream;
				try {
					this.context = new AudioContext();
					this.analyser = this.context.createAnalyser();
					this.analyser.fftSize = this.samples.length;
					this.context.createMediaStreamSource(stream).connect(this.analyser);
					for (const track of stream.getTracks()) {
						track.addEventListener(
							"ended",
							() => {
								this.interrupted(onError);
							},
							{ signal: this.lifetime.signal },
						);
					}
				} catch (error) {
					await this.dispose();
					throw error instanceof RecordingError ? error : new RecordingError("failed:" + messageOf(error));
				}
			}

			/** Acquire the microphone and start recording. */
			async start(onError) {
				if (typeof MediaRecorder === "undefined") throw new RecordingError("unavailable");
				await this.preview(onError);
				if (this.lifetime.signal.aborted) throw new RecordingError("cancelled");
				try {
					this.recorder = new MediaRecorder(this.stream);
					this.recorder.ondataavailable = (event) => {
						if (!this.lifetime.signal.aborted && event.data && event.data.size > 0) this.chunks.push(event.data);
					};
					this.recorder.onerror = () => {
						this.interrupted(onError);
					};
					this.recorder.start();
				} catch (error) {
					await this.dispose();
					throw error instanceof RecordingError ? error : new RecordingError("failed:" + messageOf(error));
				}
			}

			/** Report a device interruption once, then release resources. */
			interrupted(onError) {
				if (this.lifetime.signal.aborted) return;
				this.dispose().catch(noop);
				try {
					if (typeof onError === "function") onError(new RecordingError("interrupted"));
				} catch (error) {
					/* handler failure must not escape */
				}
			}

			/** Current microphone RMS level (0 outside capture). */
			amplitude() {
				if (!this.analyser) return 0;
				this.analyser.getFloatTimeDomainData(this.samples);
				let sum = 0;
				for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
				return Math.sqrt(sum / this.samples.length);
			}

			/**
			 * Finish capture, resample to 16 kHz mono and encode a WAV.
			 * @param {number} maxDurationSeconds host limit for the clip
			 * @returns {Promise<Uint8Array>} WAV bytes
			 */
			async stop(maxDurationSeconds) {
				const recorder = this.recorder;
				const context = this.context;
				if (!recorder || !context || recorder.state !== "recording") {
					await this.dispose();
					throw new RecordingError("empty");
				}
				try {
					await new Promise((resolve, reject) => {
						recorder.onstop = () => resolve();
						recorder.onerror = () => reject(new RecordingError("empty"));
						recorder.stop();
					});
					if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
					if (this.lifetime.signal.aborted) throw new RecordingError("cancelled");
					const blob = new Blob(this.chunks, { type: recorder.mimeType });
					if (blob.size === 0) throw new RecordingError("empty");
					const decoded = await context.decodeAudioData(await blob.arrayBuffer());
					if (this.lifetime.signal.aborted) throw new RecordingError("cancelled");
					const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
					const frames = Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000));
					const offline = new OfflineCtor(1, frames, 16000);
					const source = offline.createBufferSource();
					source.buffer = decoded;
					source.connect(offline.destination);
					source.start();
					const resampled = await offline.startRendering();
					if (this.lifetime.signal.aborted) throw new RecordingError("cancelled");
					return encodeWave(resampled.getChannelData(0));
				} finally {
					await this.dispose();
				}
			}

			/** Release this recording once (shared dispose promise). */
			dispose() {
				if (!this.disposal) {
					const self = this;
					let settleResolve;
					let settleReject;
					this.disposal = new Promise((resolve, reject) => {
						settleResolve = resolve;
						settleReject = reject;
					});
					this.release().then(settleResolve, settleReject);
					return this.disposal; // eslint-disable-line no-unreachable
				}
				return this.disposal;
			}

			/** Actual resource release (tracks, contexts, recorder). */
			async release() {
				try {
					this.lifetime.abort(new RecordingError("cancelled"));
				} catch (error) {
					/* ignore */
				}
				if (this.recorder && this.recorder.state === "recording") {
					try {
						this.recorder.stop();
					} catch (error) {
						/* ignore */
					}
				}
				if (this.stream) {
					this.stream.getTracks().forEach((track) => track.stop());
					this.stream = null;
				}
				const context = this.context;
				this.context = null;
				this.analyser = null;
				this.chunks = [];
				try {
					if (context && context.state !== "closed") await context.close();
				} finally {
					this.onDispose();
				}
			}
		}

		/** Localized text for a capture/transcription failure. */
		function failureText(failure, t) {
			if (failure instanceof RecordingError) {
				if (failure.kind === "permission") return t("dictate.micPermission");
				if (failure.kind === "deviceMissing") return t("dictate.micMissing");
				if (failure.kind === "unavailable") return t("dictate.micUnavailable");
				if (failure.kind === "interrupted") return t("dictate.micInterrupted");
				if (failure.kind === "empty") return t("dictate.micEmpty");
				if (failure.kind === "cancelled") return t("dictate.cancelled");
				if (failure.kind.indexOf("failed:") === 0) return t("dictate.micFailed", { message: failure.kind.slice(7) });
			}
			return t("dictate.error", { message: messageOf(failure) });
		}

		// ───────────────────────── icons ─────────────────────────
		/** Inline SVG icon (stroke 1.6, currentColor, decorative). */
		function icon(name, size) {
			var dimension = size || 16;
			var common = {
				width: String(dimension),
				height: String(dimension),
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
			};
			if (name === "mic") {
				return h("svg", common, h("path", { d: "M8 1.8a2.4 2.4 0 0 1 2.4 2.4v3.4a2.4 2.4 0 0 1-4.8 0V4.2A2.4 2.4 0 0 1 8 1.8Z" }), h("path", { d: "M3.6 7.6v.4a4.4 4.4 0 0 0 8.8 0v-.4" }), h("path", { d: "M8 12.4v1.8" }));
			}
			if (name === "stop") return h("svg", common, h("rect", { x: "3.8", y: "3.8", width: "8.4", height: "8.4", rx: "1.6", fill: "currentColor", stroke: "none" }));
			if (name === "close") return h("svg", common, h("path", { d: "M4.2 4.2l7.6 7.6" }), h("path", { d: "M11.8 4.2l-7.6 7.6" }));
			if (name === "caret") return h("svg", common, h("path", { d: "M4.5 6.5L8 10l3.5-3.5" }));
			if (name === "check") return h("svg", common, h("path", { d: "M3.2 8.6l3 3 6.6-6.6" }));
			if (name === "cross") return h("svg", common, h("path", { d: "M4.5 4.5l7 7" }), h("path", { d: "M11.5 4.5l-7 7" }));
			if (name === "refresh") return h("svg", common, h("path", { d: "M13 8a5 5 0 1 1-1.6-3.7" }), h("path", { d: "M13 2.6V5.4h-2.8" }));
			if (name === "spinner") return h("svg", common, h("path", { d: "M8 1.6a6.4 6.4 0 1 0 6.4 6.4" }));
			return h("svg", common);
		}

		// ───────────────────────── microphone button ─────────────────────────
		/** Live RMS meter: one CSS custom property per frame, zero re-renders. */
		function LevelBars(props) {
			const containerRef = useRef(null);
			useEffect(() => {
				const recording = props.recording;
				let alive = true;
				let frame = 0;
				const tick = () => {
					if (!alive) return;
					const container = containerRef.current;
					if (container && recording) {
						const level = recording.amplitude();
						const boosted = Math.min(1, Math.sqrt(level * 8));
						container.style.setProperty("--stt-level", boosted.toFixed(3));
					}
					frame = requestAnimationFrame(tick);
				};
				frame = requestAnimationFrame(tick);
				return () => {
					alive = false;
					cancelAnimationFrame(frame);
				};
			}, [props.recording]);
			const bars = [];
			for (let index = 0; index < 7; index += 1) bars.push(h("span", { key: String(index), className: "vsst-bar" }));
			return h("span", { className: "vsst-wave", ref: containerRef, "aria-hidden": "true" }, bars);
		}

		/**
		 * Composer dictation button registered in `conversation.input.activity`.
		 * Defensive: renders even without props and degrades to a toast when the
		 * composer actions are unavailable.
		 */
		function MicButton(props) {
			const ctx = appCtx;
			const t = bindT(ctx, props);
			const inputActions = props && props.inputActions;
			const locked = Boolean(props && props.locked);
			const prefs = loadPrefs();
			const [phase, setPhase] = useState("idle");
			const [toast, setToast] = useState(null);
			const [language, setLanguage] = useState(prefs.language || "auto");
			const [langOpen, setLangOpen] = useState(false);
			const running = useRef(null);
			const generation = useRef(0);
			const timerRef = useRef(null);
			const toastTimer = useRef(null);
			const anchorRef = useRef(null);
			const alive = useRef(true);
			const cancelRef = useRef(noop);

			useEffect(() => {
				alive.current = true;
				return () => {
					alive.current = false;
					generation.current += 1;
					if (toastTimer.current) clearTimeout(toastTimer.current);
					const active = running.current;
					running.current = null;
					if (active) {
						if (active.timer) clearInterval(active.timer);
						if (active.recording) active.recording.dispose().catch(noop);
					}
				};
			}, []);

			/** Show an inline toast; actionable toasts stay longer. */
			const showToast = useCallback((next, options) => {
				if (!alive.current) return;
				if (toastTimer.current) clearTimeout(toastTimer.current);
				toastTimer.current = null;
				setToast(next);
				if (!next) return;
				const autoDismiss = !options || options.autoDismiss !== false;
				if (!autoDismiss) return;
				toastTimer.current = setTimeout(
					() => {
						if (alive.current) setToast(null);
					},
					next.action ? 20000 : 7000,
				);
			}, []);

			/** Stop timers, dispose the active recording and return to idle. */
			const reset = useCallback((options) => {
				generation.current += 1;
				const active = running.current;
				running.current = null;
				if (active) {
					if (active.timer) clearInterval(active.timer);
					if (active.recording) active.recording.dispose().catch(noop);
				}
				setLangOpen(false);
				setPhase("idle");
				if (!options || options.keepToast !== true) showToast(null);
			}, [showToast]);
			cancelRef.current = () => reset();

			const insertText = useCallback(
				(text) => {
					const actions = inputActions;
					if (!actions) return false;
					if (typeof actions.insertText === "function") {
						const active = running.current;
						try {
							if (active && active.span && actions.insertText(text, active.span)) return true;
						} catch (error) {
							/* retry once with a fresh span */
						}
						try {
							if (typeof actions.captureInsertion === "function" && actions.insertText(text, actions.captureInsertion())) return true;
						} catch (error) {
							/* fall through to setDraft */
						}
					}
					if (typeof actions.setDraft === "function") {
						try {
							actions.setDraft(text);
							return true;
						} catch (error) {
							return false;
						}
					}
					return false;
				},
				[inputActions],
			);

			/** Stop capture and send the WAV for transcription. */
			const finish = useCallback(async () => {
				const active = running.current;
				if (!active || active.stopping) return;
				active.stopping = true;
				const run = active.generation;
				if (active.timer) {
					clearInterval(active.timer);
					active.timer = null;
				}
				setPhase("transcribing");
				try {
					const wave = await active.recording.stop(active.maxSeconds);
					if (run !== generation.current || !alive.current) return;
					const result = await callRpc(ctx, "transcribe", {
						audioBase64: audioBase64(wave),
						language: language,
					});
					if (run !== generation.current || !alive.current) return;
					running.current = null;
					const text = typeof result.text === "string" ? result.text.trim() : "";
					if (text === "") {
						setPhase("idle");
						showToast({ kind: "info", message: t("dictate.empty") });
						return;
					}
					if (!insertText(text)) {
						setPhase("idle");
						showToast({ kind: "error", message: t("dictate.insertFailed") });
						return;
					}
					setPhase("idle");
				} catch (failure) {
					if (run !== generation.current || !alive.current) return;
					running.current = null;
					setPhase("idle");
					showToast({ kind: "error", message: failureText(failure, t), action: "prepare" });
				}
			}, [ctx, insertText, language, showToast, t]);

			/** Ask for the microphone and start recording. */
			const start = useCallback(async () => {
				if (locked) return;
				showToast(null);
				if (!inputActions) {
					showToast({ kind: "error", message: t("dictate.noComposer") });
					return;
				}
				const run = generation.current + 1;
				generation.current = run;
				setPhase("requesting");
				const recording = new Recording(noop);
				const active = { recording: recording, timer: null, startedAt: 0, span: null, maxSeconds: 60, generation: run, stopping: false };
				running.current = active;
				try {
					const status = await getStatus(ctx, 15000);
					if (run !== generation.current || !alive.current) {
						await recording.dispose().catch(noop);
						return;
					}
					if (!status || status.ready !== true) {
						running.current = null;
						await recording.dispose().catch(noop);
						setPhase("idle");
						showToast({ kind: "error", message: t("dictate.setupRequired"), action: "prepare" });
						return;
					}
					active.maxSeconds = Math.min(MAX_SECONDS_HARD, Math.max(1, Number((status.limits && status.limits.maxAudioSeconds) || 60)));
					try {
						active.span = typeof inputActions.captureInsertion === "function" ? inputActions.captureInsertion() : null;
					} catch (error) {
						active.span = null;
					}
					await recording.start((failure) => {
						if (run !== generation.current || !alive.current) return;
						running.current = null;
						setPhase("idle");
						showToast({ kind: "error", message: failureText(failure, t) });
					});
					if (run !== generation.current || !alive.current) {
						await recording.dispose().catch(noop);
						return;
					}
					active.startedAt = Date.now();
					setPhase("recording");
					active.timer = setInterval(() => {
						const elapsed = Date.now() - active.startedAt;
						if (timerRef.current) timerRef.current.textContent = formatMmSs(elapsed / 1000);
						if (elapsed >= active.maxSeconds * 1000) finish();
					}, 250);
				} catch (failure) {
					running.current = null;
					await recording.dispose().catch(noop);
					if (run !== generation.current || !alive.current) return;
					setPhase("idle");
					showToast({ kind: "error", message: failureText(failure, t) });
				}
			}, [ctx, finish, inputActions, locked, showToast, t]);

			/** Run the preparation pipeline from the actionable toast. */
			const prepareFromToast = useCallback(async () => {
				showToast({ kind: "info", message: t("dictate.preparing", { phase: t("settings.phase.venv"), progress: 0 }) });
				try {
					const snapshot = await startPreparation(ctx, (progress) => {
						if (!alive.current) return;
						showToast({
							kind: "info",
							message: t("dictate.preparing", {
								phase: t("settings.phase." + progress.phase),
								progress: Math.round((progress.progress || 0) * 100),
							}),
						});
					});
					invalidateStatus();
					if (snapshot.phase === "ready") {
						showToast({ kind: "info", message: t("dictate.prepareDone") });
					} else if (snapshot.phase === "error") {
						showToast({ kind: "error", message: t("dictate.prepareFailed", { message: snapshot.error || "" }), action: "prepare" });
					} else {
						showToast({ kind: "info", message: t("dictate.cancelled") });
					}
				} catch (failure) {
					showToast({ kind: "error", message: t("dictate.prepareFailed", { message: messageOf(failure) }), action: "prepare" });
				}
			}, [ctx, showToast, t]);

			/** Escape cancels/close popover; blur/visibility cancel recording. */
			useEffect(() => {
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					if (langOpen) {
						event.preventDefault();
						setLangOpen(false);
						return;
					}
					if (running.current || phase !== "idle") {
						event.preventDefault();
						cancelRef.current();
					}
				};
				const onBlur = () => {
					if (running.current) cancelRef.current();
				};
				const onVisibility = () => {
					if (document.hidden && running.current) cancelRef.current();
				};
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("blur", onBlur);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					document.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("blur", onBlur);
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, [langOpen, phase]);

			/** Close the language popover on outside click. */
			useEffect(() => {
				if (!langOpen) return undefined;
				const onMouseDown = (event) => {
					const anchor = anchorRef.current;
					if (anchor && !anchor.contains(event.target)) setLangOpen(false);
				};
				document.addEventListener("mousedown", onMouseDown);
				return () => document.removeEventListener("mousedown", onMouseDown);
			}, [langOpen]);

			const onPrimary = () => {
				if (phase === "idle") start();
				else if (phase === "recording") finish();
				else reset();
			};
			const selectLanguage = (next) => {
				setLanguage(next);
				setLangOpen(false);
				const prefsNext = loadPrefs();
				prefsNext.language = next;
				savePrefs(prefsNext);
			};
			const primaryLabel =
				phase === "idle"
					? t("dictate.start")
					: phase === "recording"
						? t("dictate.stop")
						: phase === "requesting"
							? t("dictate.cancel")
							: t("dictate.cancel");
			const primaryIcon = phase === "recording" ? "stop" : phase === "idle" ? "mic" : phase === "requesting" ? "mic" : "close";
			const languageLabel = language === "pt" ? t("dictate.langPt") : language === "en" ? t("dictate.langEn") : t("dictate.langAuto");

			const primaryButton = h(
				"button",
				{
					type: "button",
					className: cx("vsst-btn", "vsst-primary"),
					"data-voice-stt-button": "",
					"data-voice-stt-state": phase,
					"data-state": phase,
					"aria-label": primaryLabel,
					title: primaryLabel,
					disabled: Boolean(locked),
					onMouseDown: (event) => event.preventDefault(),
					onClick: onPrimary,
				},
				icon(primaryIcon, 17),
			);

			const languageButton = h(
				"button",
				{
					type: "button",
					className: cx("vsst-btn", "vsst-lang"),
					"data-voice-stt-lang": language,
					"aria-label": t("dictate.language") + ": " + languageLabel,
					title: t("dictate.language") + ": " + languageLabel,
					"aria-haspopup": "menu",
					"aria-expanded": String(langOpen),
					onMouseDown: (event) => event.preventDefault(),
					onClick: () => setLangOpen(!langOpen),
				},
				icon("caret", 13),
			);

			const popover = langOpen
				? h(
						"div",
						{ className: "vsst-pop", role: "menu", "aria-label": t("dictate.language") },
						LANGUAGES.map((entry) =>
							h(
								"button",
								{
									key: entry[0],
									type: "button",
									role: "menuitemradio",
									"aria-checked": String(language === entry[0]),
									onClick: () => selectLanguage(entry[0]),
								},
								t(entry[1]),
							),
						),
					)
				: null;

			const toastNode = toast
				? h(
						"span",
						{ className: cx("vsst-toast", toast.kind === "error" ? "vsst-toast-error" : "vsst-toast-info"), role: "status" },
						h("span", { className: "vsst-toast-text", title: toast.message }, toast.message),
						toast.action === "prepare"
							? h(
									"button",
									{
										type: "button",
										className: "vsst-link",
										onMouseDown: (event) => event.preventDefault(),
										onClick: prepareFromToast,
									},
									t("dictate.actionPrepare"),
								)
							: null,
						h(
							"button",
							{
								type: "button",
								className: "vsst-btn vsst-toast-close",
								"aria-label": t("common.close"),
								title: t("common.close"),
								onMouseDown: (event) => event.preventDefault(),
								onClick: () => showToast(null),
							},
							icon("cross", 12),
						),
					)
				: null;

			if (phase === "idle" && !toast) {
				return h(
					"span",
					{ className: "vsst-anchor", ref: anchorRef },
					primaryButton,
					languageButton,
					popover,
				);
			}

			return h(
				"span",
				{ className: cx("vsst-anchor", "vsst-active"), ref: anchorRef, role: "group", "aria-label": t("dictate.group") },
				h(
					"span",
					{ className: "vsst-row" },
					h(
						"button",
						{
							type: "button",
							className: cx("vsst-btn", "vsst-cancel"),
							"aria-label": t("dictate.discard"),
							title: t("dictate.discard"),
							onMouseDown: (event) => event.preventDefault(),
							onClick: reset,
						},
						icon("close", 13),
					),
					primaryButton,
					phase === "recording"
						? h(
								"span",
								{ className: "vsst-status" },
								h(LevelBars, { recording: running.current && running.current.recording }),
								h("span", { className: "vsst-timer", ref: timerRef, "aria-hidden": "true" }, "00:00"),
								h("span", { className: "vsst-sr", role: "status" }, t("dictate.recording")),
							)
						: h(
								"span",
								{ className: "vsst-status", role: "status" },
								h("span", { className: "vsst-spin" }, icon("spinner", 14)),
								h("span", { className: "vsst-status-text" }, t(phase === "requesting" ? "dictate.requesting" : "dictate.transcribing")),
							),
					languageButton,
				),
				toastNode,
				popover,
			);
		}

		// ───────────────────────── settings section ─────────────────────────
		/** One check row with a success/failure icon. */
		function CheckRow(props) {
			const ok = Boolean(props.ok);
			return h(
				"li",
				{ className: "vsst-check", "data-ok": String(ok) },
				h("span", { className: "vsst-check-icon", "aria-hidden": "true" }, icon(ok ? "check" : "cross", 13)),
				h(
					"span",
					{ className: "vsst-check-body" },
					h("span", { className: "vsst-check-label" }, props.label),
					h("span", { className: "vsst-check-detail" }, props.detail),
				),
			);
		}

		/**
		 * Settings section registered in `settings.section` as `voice-stt`:
		 * runtime checks, preferences, preparation and a real microphone test.
		 */
		function SettingsSection(props) {
			const ctx = appCtx;
			const t = bindT(ctx, props);
			const [status, setStatus] = useState(null);
			const [error, setError] = useState(null);
			const [loading, setLoading] = useState(true);
			const [saving, setSaving] = useState(false);
			const [prepare, setPrepare] = useState({ phase: "idle", progress: 0, message: "", error: null });
			const [preparing, setPreparing] = useState(false);
			const [test, setTest] = useState({ phase: "idle", text: "", ms: 0, device: "", message: "" });
			const alive = useRef(true);
			const generation = useRef(0);
			const recording = useRef(null);

			const refresh = useCallback(
				async (force) => {
					try {
						const value = await getStatus(ctx, force ? 0 : 5000);
						if (!alive.current) return;
						setStatus(value);
						setError(null);
					} catch (failure) {
						if (!alive.current) return;
						setError(messageOf(failure));
					} finally {
						if (alive.current) setLoading(false);
					}
				},
				[ctx],
			);

			useEffect(() => {
				alive.current = true;
				refresh(false);
				return () => {
					alive.current = false;
					generation.current += 1;
					const active = recording.current;
					recording.current = null;
					if (active) active.dispose().catch(noop);
				};
			}, [refresh]);

			/** Persist one config patch (validated by the server). */
			const patchConfig = useCallback(
				async (patch) => {
					setSaving(true);
					setError(null);
					try {
						const result = await callRpc(ctx, "setConfig", patch);
						invalidateStatus();
						if (alive.current) {
							setStatus((previous) => (previous ? Object.assign({}, previous, { config: result.config }) : previous));
						}
						await refresh(true);
					} catch (failure) {
						if (alive.current) setError(t("settings.saveError", { message: messageOf(failure) }));
					} finally {
						if (alive.current) setSaving(false);
					}
				},
				[ctx, refresh, t],
			);

			/** Start preparation and track its phases. */
			const onPrepare = useCallback(async () => {
				if (preparing) return;
				setPreparing(true);
				setPrepare({ phase: "venv", progress: 0, message: "", error: null });
				try {
					const snapshot = await startPreparation(ctx, (progress) => {
						if (alive.current) setPrepare(progress);
					});
					invalidateStatus();
					if (alive.current) setPrepare(snapshot);
					await refresh(true);
				} catch (failure) {
					if (alive.current) setPrepare({ phase: "error", progress: 0, message: "", error: messageOf(failure) });
				} finally {
					if (alive.current) setPreparing(false);
				}
			}, [ctx, preparing, refresh]);

			/** Cancel a running preparation. */
			const onCancelPrepare = useCallback(async () => {
				try {
					await callRpc(ctx, "cancel", {});
				} catch (failure) {
					if (alive.current) setError(messageOf(failure));
				}
				if (alive.current) setPreparing(false);
			}, [ctx]);

			/** Record ~4 s and transcribe it to validate the whole pipeline. */
			const onTest = useCallback(async () => {
				if (test.phase === "recording" || test.phase === "transcribing" || test.phase === "requesting") return;
				generation.current += 1;
				const run = generation.current;
				setTest({ phase: "requesting", text: "", ms: 0, device: "", message: "" });
				const active = new Recording(() => {
					if (recording.current === active) recording.current = null;
				});
				recording.current = active;
				try {
					await active.start((failure) => {
						if (run !== generation.current || !alive.current) return;
						setTest({ phase: "error", text: "", ms: 0, device: "", message: failureText(failure, t) });
					});
					if (run !== generation.current || !alive.current) {
						await active.dispose().catch(noop);
						return;
					}
					setTest({ phase: "recording", text: "", ms: 0, device: "", message: "" });
					await delay(4000);
					if (run !== generation.current || !alive.current) {
						await active.dispose().catch(noop);
						return;
					}
					setTest({ phase: "transcribing", text: "", ms: 0, device: "", message: "" });
					const wave = await active.stop(15);
					recording.current = null;
					if (run !== generation.current || !alive.current) return;
					const language = (status && status.config && status.config.language) || "auto";
					const result = await callRpc(ctx, "transcribe", { audioBase64: audioBase64(wave), language: language });
					if (run !== generation.current || !alive.current) return;
					if (!result.text) {
						setTest({ phase: "empty", text: "", ms: 0, device: "", message: "" });
						return;
					}
					setTest({
						phase: "done",
						text: result.text,
						ms: result.inferenceMs || 0,
						device: String(result.device || "").toUpperCase(),
						message: "",
					});
				} catch (failure) {
					recording.current = null;
					await active.dispose().catch(noop);
					if (run !== generation.current || !alive.current) return;
					setTest({ phase: "error", text: "", ms: 0, device: "", message: failureText(failure, t) });
				}
			}, [ctx, status, t, test.phase]);

			const config = (status && status.config) || {};
			const checks = (status && status.checks) || [];
			const ready = Boolean(status && status.ready);
			const phaseLabel = t("settings.phase." + (prepare.phase || "idle"));
			const percent = Math.round((prepare.progress || 0) * 100);
			const runtime = (status && status.runtime) || {};

			const runtimeCard = h(
				"section",
				{ className: "vsst-card" },
				h(
					"header",
					{ className: "vsst-card-head" },
					h("h3", { className: "vsst-card-title" }, t("settings.runtime")),
					h(
						"span",
						{ className: cx("vsst-badge", ready ? "vsst-badge-ok" : "vsst-badge-off"), "data-ready": String(ready) },
						ready ? t("settings.ready") : t("settings.notReady"),
					),
					h(
						"button",
						{
							type: "button",
							className: "vsst-btn vsst-refresh",
							"aria-label": t("settings.refresh"),
							title: t("settings.refresh"),
							onClick: () => refresh(true),
						},
						icon("refresh", 14),
					),
				),
				loading
					? h("p", { className: "vsst-muted" }, t("common.loading"))
					: h(
							"ul",
							{ className: "vsst-checks", "aria-label": t("settings.checks") },
							checks.map((check) =>
								h(CheckRow, {
									key: check.id,
									ok: check.ok,
									label: t("settings.check." + check.id),
									detail: check.detail || "",
								}),
							),
						),
				runtime.workerRunning
					? h(
							"p",
							{ className: "vsst-muted" },
							t("settings.runtimeDevice", {
								device: String(runtime.device || "?").toUpperCase(),
								computeType: runtime.computeType || "?",
							}),
						)
					: ready
						? h("p", { className: "vsst-muted" }, t("settings.workerIdle"))
						: null,
				error ? h("p", { className: "vsst-error", role: "alert" }, error) : null,
			);

			const configCard = h(
				"section",
				{ className: "vsst-card" },
				h("header", { className: "vsst-card-head" }, h("h3", { className: "vsst-card-title" }, t("settings.model"))),
				h(
					"div",
					{ className: "vsst-fields" },
					h(
						"label",
						{ className: "vsst-field" },
						h("span", { className: "vsst-field-label" }, t("settings.model")),
						h(
							"select",
							{
								className: "vsst-select",
								value: config.model || "small",
								disabled: Boolean(saving || preparing),
								onChange: (event) => patchConfig({ model: event.target.value }),
							},
							MODELS.map((model) => h("option", { key: model, value: model }, model)),
						),
					),
					h(
						"label",
						{ className: "vsst-field" },
						h("span", { className: "vsst-field-label" }, t("settings.language")),
						h(
							"select",
							{
								className: "vsst-select",
								value: config.language || "auto",
								disabled: Boolean(saving),
								onChange: (event) => patchConfig({ language: event.target.value }),
							},
							LANGUAGES.map((entry) => h("option", { key: entry[0], value: entry[0] }, t(entry[1]))),
						),
					),
					h(
						"label",
						{ className: "vsst-field" },
						h("span", { className: "vsst-field-label" }, t("settings.device")),
						h(
							"select",
							{
								className: "vsst-select",
								value: config.device || "auto",
								disabled: Boolean(saving || preparing),
								onChange: (event) => patchConfig({ device: event.target.value }),
							},
							h("option", { value: "auto" }, t("settings.deviceAuto")),
							h("option", { value: "cuda" }, t("settings.deviceCuda")),
							h("option", { value: "cpu" }, t("settings.deviceCpu")),
						),
					),
					h(
						"label",
						{ className: "vsst-field" },
						h("span", { className: "vsst-field-label" }, t("settings.cudaLibs")),
						h(
							"select",
							{
								className: "vsst-select",
								"data-voice-stt-cudalibs": String(config.cudaLibs || "auto"),
								value: config.cudaLibs || "auto",
								disabled: Boolean(saving || preparing),
								onChange: (event) => patchConfig({ cudaLibs: event.target.value }),
							},
							h("option", { value: "auto" }, t("settings.cudaLibsAuto")),
							h("option", { value: "off" }, t("settings.cudaLibsOff")),
						),
					),
					h(
						"label",
						{ className: "vsst-field" },
						h("span", { className: "vsst-field-label" }, t("settings.maxSeconds")),
						h("input", {
							className: "vsst-select",
							type: "number",
							min: "1",
							max: String(MAX_SECONDS_HARD),
							step: "1",
							value: String(config.maxAudioSeconds || 60),
							disabled: Boolean(saving),
							onChange: (event) => {
								const value = Number(event.target.value);
								if (Number.isFinite(value) && value >= 1 && value <= MAX_SECONDS_HARD) {
									patchConfig({ maxAudioSeconds: Math.round(value) });
								}
							},
						}),
					),
					h(
						"label",
						{ className: "vsst-field" },
						h("span", { className: "vsst-field-label" }, t("settings.idle")),
						h("input", {
							className: "vsst-select",
							type: "number",
							min: "1",
							max: "120",
							step: "1",
							value: String(config.idleShutdownMinutes || 10),
							disabled: Boolean(saving),
							onChange: (event) => {
								const value = Number(event.target.value);
								if (Number.isFinite(value) && value >= 1 && value <= 120) {
									patchConfig({ idleShutdownMinutes: Math.round(value) });
								}
							},
						}),
					),
				),
			);

			const preparingNow = preparing || (prepare.phase !== "idle" && prepare.phase !== "ready" && prepare.phase !== "error");
			const prepareCard = h(
				"section",
				{ className: "vsst-card" },
				h("header", { className: "vsst-card-head" }, h("h3", { className: "vsst-card-title" }, t("settings.prepare"))),
				h(
					"div",
					{ className: "vsst-actions" },
					h(
						"button",
						{
							type: "button",
							className: "vsst-btn-primary",
							disabled: Boolean(preparingNow),
							onClick: onPrepare,
						},
						ready ? t("settings.reprepare") : t("settings.prepare"),
					),
					preparingNow
						? h("button", { type: "button", className: "vsst-btn-secondary", onClick: onCancelPrepare }, t("settings.cancel"))
						: null,
				),
				h(
					"div",
					{ className: "vsst-progress-wrap" },
					h(
						"div",
						{ className: "vsst-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) },
						h("span", { style: { width: percent + "%" } }),
					),
					h("p", { className: "vsst-muted" }, t("settings.phaseHint", { phase: phaseLabel, progress: percent })),
					prepare.message ? h("p", { className: "vsst-muted vsst-ellipsis", title: prepare.message }, prepare.message) : null,
					prepare.error ? h("p", { className: "vsst-error", role: "alert" }, prepare.error) : null,
				),
			);

			const testBusy = test.phase === "requesting" || test.phase === "recording" || test.phase === "transcribing";
			const testCard = h(
				"section",
				{ className: "vsst-card" },
				h("header", { className: "vsst-card-head" }, h("h3", { className: "vsst-card-title" }, t("settings.test"))),
				h(
					"div",
					{ className: "vsst-actions" },
					h(
						"button",
						{
							type: "button",
							className: "vsst-btn-secondary",
							"data-voice-stt-test": "",
							disabled: Boolean(testBusy) || !ready,
							onClick: onTest,
						},
						testBusy ? t("settings.testRecording") : t("settings.test"),
					),
					h("span", { className: "vsst-muted" }, t("settings.testHint")),
				),
				test.phase === "recording" ? h("p", { className: "vsst-muted", role: "status" }, t("settings.testRecording")) : null,
				test.phase === "transcribing" ? h("p", { className: "vsst-muted", role: "status" }, t("settings.testTranscribing")) : null,
				test.phase === "done"
					? h("p", { className: "vsst-test-result" }, t("settings.testResult", { text: test.text, ms: test.ms, device: test.device || "?" }))
					: null,
				test.phase === "empty" ? h("p", { className: "vsst-muted" }, t("settings.testEmpty")) : null,
				test.phase === "error" ? h("p", { className: "vsst-error", role: "alert" }, test.message) : null,
			);

			const paths = (status && status.paths) || {};
			const pathsCard = paths.home
				? h(
						"section",
						{ className: "vsst-card" },
						h("header", { className: "vsst-card-head" }, h("h3", { className: "vsst-card-title" }, t("settings.paths"))),
						h("p", { className: "vsst-muted" }, t("settings.pathsHome", { home: paths.home })),
						paths.logs ? h("p", { className: "vsst-muted" }, t("settings.pathsLogs", { logs: paths.logs })) : null,
					)
				: null;

			return h(
				"div",
				{ className: "vsst-settings", "data-voice-stt-settings": "" },
				h("p", { className: "vsst-intro" }, t("settings.intro")),
				runtimeCard,
				configCard,
				prepareCard,
				testCard,
				pathsCard,
				h("p", { className: "vsst-muted" }, t("settings.privacy")),
			);
		}

		// ───────────────────────── styles ─────────────────────────
		// Every color is a --dsw-* theme token: zero hardcoded color values.
		const CSS = `
.vsst-anchor{display:inline-flex;align-items:center;gap:6px;flex:none;position:relative;min-height:28px}
.vsst-anchor.vsst-active{gap:8px}
.vsst-row{display:inline-flex;align-items:center;gap:8px;min-height:28px}
.vsst-btn{width:28px;height:28px;min-width:28px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;line-height:1}
.vsst-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.vsst-btn:disabled{opacity:.55;cursor:not-allowed}
.vsst-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.vsst-primary[data-state=recording]{color:var(--dsw-alias-state-error-primary)}
.vsst-primary[data-state=requesting],.vsst-primary[data-state=transcribing]{color:var(--dsw-alias-state-business-primary)}
.vsst-lang{width:20px;min-width:20px;color:var(--dsw-alias-label-tertiary)}
.vsst-cancel{color:var(--dsw-alias-label-secondary)}
.vsst-status{display:inline-flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.vsst-status-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vsst-wave{display:inline-flex;align-items:center;gap:2px;height:18px;color:var(--dsw-alias-state-error-primary)}
.vsst-bar{display:block;width:3px;height:18px;border-radius:2px;background:currentColor;transform:scaleY(calc(.18 + var(--stt-level,0) * var(--stt-factor,.75)));transform-origin:center;transition:transform .08s linear}
.vsst-bar:nth-child(1){--stt-factor:.55}
.vsst-bar:nth-child(2){--stt-factor:.95}
.vsst-bar:nth-child(3){--stt-factor:.7}
.vsst-bar:nth-child(4){--stt-factor:1}
.vsst-bar:nth-child(5){--stt-factor:.7}
.vsst-bar:nth-child(6){--stt-factor:.95}
.vsst-bar:nth-child(7){--stt-factor:.55}
.vsst-timer{font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:38px}
.vsst-pop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:30;display:flex;flex-direction:column;gap:2px;min-width:132px;padding:4px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 6px 24px var(--dsw-alias-bg-mask-3)}
.vsst-pop button{text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 8px;border-radius:6px;cursor:pointer;min-height:26px}
.vsst-pop button:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.vsst-pop button[aria-checked=true]{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}
.vsst-pop button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.vsst-toast{display:inline-flex;align-items:center;gap:6px;max-width:340px;padding:2px 4px 2px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-mask-2);color:var(--dsw-alias-label-primary);font-size:12px}
.vsst-toast-error{border-color:var(--dsw-alias-state-error-primary)}
.vsst-toast-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.vsst-toast-close{width:22px;min-width:22px;height:22px}
.vsst-link{border:none;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:2px 4px;border-radius:4px;white-space:nowrap}
.vsst-link:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.vsst-link:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.vsst-spin{display:inline-flex;color:var(--dsw-alias-state-business-primary);animation:vsst-spin 1s linear infinite}
@keyframes vsst-spin{to{transform:rotate(360deg)}}
.vsst-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.vsst-settings{display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:760px}
.vsst-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}
.vsst-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-module-platform)}
.vsst-card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.vsst-card-title{margin:0;font-size:13px;font-weight:600}
.vsst-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.vsst-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.vsst-badge-off{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.vsst-refresh{margin-left:auto}
.vsst-checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.vsst-check{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.45}
.vsst-check-icon{display:inline-flex;margin-top:1px;color:var(--dsw-alias-label-tertiary)}
.vsst-check[data-ok=true] .vsst-check-icon{color:var(--dsw-alias-state-success-primary)}
.vsst-check[data-ok=false] .vsst-check-icon{color:var(--dsw-alias-state-error-primary)}
.vsst-check-body{display:flex;flex-direction:column;min-width:0}
.vsst-check-label{color:var(--dsw-alias-label-primary);font-weight:500}
.vsst-check-detail{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.vsst-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.vsst-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.vsst-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.vsst-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;min-height:28px;width:100%;box-sizing:border-box}
.vsst-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.vsst-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vsst-btn-primary{min-height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-static-neutral-00);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.vsst-btn-primary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent)}
.vsst-btn-primary:disabled{opacity:.6;cursor:not-allowed}
.vsst-btn-secondary{min-height:28px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.vsst-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.vsst-btn-secondary:disabled{opacity:.55;cursor:not-allowed}
.vsst-btn-primary:focus-visible,.vsst-btn-secondary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.vsst-progress-wrap{display:flex;flex-direction:column;gap:6px}
.vsst-progress{height:6px;border-radius:3px;background:var(--dsw-alias-bg-mask-2);overflow:hidden}
.vsst-progress>span{display:block;height:100%;background:var(--dsw-alias-state-business-primary);transition:width .3s ease}
.vsst-muted{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.45}
.vsst-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vsst-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.vsst-test-result{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
`;
		const claimedStyles = new WeakSet();
		/**
		 * Claim the plugin stylesheet through ctx.effect so unloading removes it.
		 * Repeated claims keep returning a working disposer.
		 */
		function claimStyles() {
			if (typeof document === "undefined") return function () {};
			const found = document.querySelector('style[data-plugin="dsh-whisper-stt"]');
			let style = found;
			if (!style) {
				style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-whisper-stt");
				style.textContent = CSS;
				document.head.appendChild(style);
			}
			claimedStyles.add(style);
			return function () {
				if (!claimedStyles.has(style)) return;
				claimedStyles.delete(style);
				if (style.parentNode) style.parentNode.removeChild(style);
			};
		}

		// ───────────────────────── plugin body ─────────────────────────
		/**
		 * Register one slot whether the host exposes `slots.inject` (defer until
		 * the slot exists) or only `slots.register`.
		 */
		function registerSlot(ctx, slotName, entry, Component) {
			const slots = ctx && ctx.slots;
			if (!slots || typeof slots.register !== "function") return noop;
			const register = () => slots.register(entry, Component);
			if (typeof slots.inject === "function") {
				const dispose = slots.inject(slotName, register);
				return function () {
					try {
						if (typeof dispose === "function") dispose();
					} catch (error) {
						/* already disposed */
					}
				};
			}
			return register();
		}

		/** Install the diagnostic hook used by E2E and manual debugging. */
		function installDebugHook(ctx) {
			if (typeof window === "undefined") return;
			try {
				const bag = (window.__dshVoiceDebug = window.__dshVoiceDebug || {});
				bag.stt = {
					plugin: PLUGIN_ID,
					version: VERSION,
					rpc: (endpoint, payload) => callRpc(ctx, endpoint, payload),
				};
			} catch (error) {
				/* diagnostics must never break boot */
			}
		}

		/**
		 * Mount the client half: styles, dictionaries, composer microphone and
		 * settings section, plus the `window.__dshVoiceDebug.stt` hook.
		 *
		 * @param {any} ctx client runtime context
		 * @returns {() => void} disposer removing the stylesheet and debug hook
		 */
		function apply(ctx) {
			appCtx = ctx;
			installDebugHook(ctx);
			ctx.effect(() => claimStyles(), "dsh-whisper-stt: styles");
			ctx.effect(() => ctx.locale.register(NS, dict), "dsh-whisper-stt: dictionaries");
			ctx.effect(
				() =>
					registerSlot(ctx, "conversation.input.activity", { name: "conversation.input.activity", locale: NS }, MicButton),
				"dsh-whisper-stt: microphone slot",
			);
			ctx.effect(
				() =>
					registerSlot(
						ctx,
						"settings.section",
						{
							name: "settings.section",
							id: "voice-stt",
							order: 60,
							label: () => dictT("settings.nav"),
							locale: NS,
						},
						SettingsSection,
					),
				"dsh-whisper-stt: settings slot",
			);
			return function dispose() {
				appCtx = null;
				if (typeof window !== "undefined" && window.__dshVoiceDebug) {
					try {
						delete window.__dshVoiceDebug.stt;
					} catch (error) {
						/* ignore */
					}
				}
			};
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale", "connection", "sessions"];
		exports.__dict = dict;
		exports.__components = { MicButton: MicButton, SettingsSection: SettingsSection };
		return module.exports;
	},
});
