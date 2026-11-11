#!/usr/bin/env python3
"""dsh-whisper-stt worker: persistent faster-whisper transcription process.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.

  request   {"id": 1, "cmd": "prepare",    "model": "small"}
  request   {"id": 2, "cmd": "transcribe", "wav_b64": "...", "language": "pt"|null}
  request   {"id": 3, "cmd": "status"}
  request   {"id": 4, "cmd": "shutdown"}

  response  {"id": 1, "ok": true, "result": {...}}
  error     {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
  progress  {"event": "progress", "phase": "model", "progress": 0.4, "message": "..."}

stdout carries JSON protocol lines only. Everything diagnostic goes to stderr,
which the Node host captures into <stt-home>/logs/worker.log.

Audio contract: 16 kHz mono PCM16 WAV, base64 without a data-URL prefix. The
Node host validates it before forwarding, but this process re-validates because
it is the last boundary before the model.

The process exits after ``STT_IDLE_SECONDS`` (default 600 s) without requests,
and also when stdin closes (host shutdown).
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import sys
import threading
import time
import wave
from typing import Any

LOG = sys.stderr


def log(*parts: Any) -> None:
    """Write one diagnostic line to stderr (never stdout)."""
    print("[worker]", *parts, file=LOG, flush=True)


logging.basicConfig(stream=LOG, level=logging.WARNING, format="[%(levelname)s] %(message)s")

# ── configuration (environment is set by the Node host) ──────────────────────
MODELS_DIR = os.environ.get("STT_MODELS_DIR") or ""
MODEL_NAME = os.environ.get("STT_MODEL") or "small"
DEVICE = os.environ.get("STT_DEVICE") or "auto"
COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE") or "auto"
BEAM_SIZE = int(os.environ.get("STT_BEAM_SIZE") or 5)
IDLE_SECONDS = float(os.environ.get("STT_IDLE_SECONDS") or 600)
SAMPLE_RATE = 16000

_model = None
_model_name: str | None = None
_loaded_device: str | None = None
_loaded_compute: str | None = None
_load_state = threading.Lock()
_idle_lock = threading.Lock()
_idle_timer: threading.Timer | None = None


# ── protocol helpers ────────────────────────────────────────────────────────
def send(payload: dict) -> None:
    """Emit exactly one JSON line on stdout and flush immediately."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_progress(phase: str, progress: float, message: str) -> None:
    """Report coarse preparation progress to the host (JSON, stdout)."""
    send({"event": "progress", "phase": phase, "progress": round(float(progress), 3), "message": message})


def fail(req_id: Any, code: str, message: str) -> None:
    """Emit the protocol error branch for one request."""
    send({"id": req_id, "ok": False, "error": {"code": code, "message": str(message)}})


# ── idle shutdown ───────────────────────────────────────────────────────────
def _idle_exit() -> None:
    log(f"idle timeout after {IDLE_SECONDS:.0f}s; exiting")
    try:
        send({"event": "idle-exit"})
    except Exception:  # noqa: BLE001 - stdout may already be gone
        pass
    os._exit(0)


def pause_idle() -> None:
    """Cancel a pending idle exit while a request is being processed."""
    global _idle_timer
    with _idle_lock:
        if _idle_timer is not None:
            _idle_timer.cancel()
            _idle_timer = None


def arm_idle() -> None:
    """Arm (or re-arm) the idle shutdown timer."""
    global _idle_timer
    if IDLE_SECONDS <= 0:
        return
    with _idle_lock:
        if _idle_timer is not None:
            _idle_timer.cancel()
        _idle_timer = threading.Timer(IDLE_SECONDS, _idle_exit)
        _idle_timer.daemon = True
        _idle_timer.start()


# ── environment introspection ───────────────────────────────────────────────
def _version_of(module_name: str) -> str | None:
    try:
        module = __import__(module_name)
        return getattr(module, "__version__", None) or "unknown"
    except Exception:  # noqa: BLE001 - reported as unavailable
        return None


def cuda_info() -> dict:
    """Report CUDA availability without loading a model."""
    info: dict[str, Any] = {"available": False, "deviceCount": 0, "detail": "ctranslate2 indisponível"}
    try:
        import ctranslate2  # noqa: PLC0415 - optional heavy import

        count = int(ctranslate2.get_cuda_device_count())
        info["deviceCount"] = count
        info["available"] = count > 0
        info["detail"] = f"{count} dispositivo(s) CUDA visível(is)" if count > 0 else "nenhum dispositivo CUDA visível"
        info["version"] = getattr(ctranslate2, "__version__", None)
    except Exception as exc:  # noqa: BLE001
        info["detail"] = f"ctranslate2: {exc}"
    return info


def model_dir_hint(name: str) -> str | None:
    """Return the cache directory for a model if it already exists."""
    if not MODELS_DIR or not os.path.isdir(MODELS_DIR):
        return None
    try:
        entries = os.listdir(MODELS_DIR)
    except OSError:
        return None
    needle = f"faster-whisper-{name}"
    for entry in entries:
        if needle in entry and os.path.isdir(os.path.join(MODELS_DIR, entry)):
            return os.path.join(MODELS_DIR, entry)
    return None


# ── model lifecycle ─────────────────────────────────────────────────────────
def _choose_attempts(device: str, compute_type: str) -> list[tuple[str, str]]:
    """Build the ordered (device, compute_type) attempts with a CPU fallback."""
    requested = (device or "auto").lower()
    explicit_compute = (compute_type or "auto").lower()
    if requested == "cpu":
        return [("cpu", explicit_compute if explicit_compute not in ("auto", "float16") else "int8")]
    cuda_attempt = ("cuda", explicit_compute if explicit_compute not in ("auto", "int8") else "float16")
    cpu_attempt = ("cpu", "int8")
    if requested == "cuda":
        return [cuda_attempt, cpu_attempt]
    if cuda_info().get("available"):
        return [cuda_attempt, cpu_attempt]
    return [cpu_attempt]


def _reset_model() -> None:
    """Forget the loaded model so the next load can switch device."""
    global _model, _model_name, _loaded_device, _loaded_compute
    _model = None
    _model_name = None
    _loaded_device = None
    _loaded_compute = None


def _warmup(model) -> None:
    """Run a tiny inference so broken CUDA/cuBLAS/cuDNN is detected at load time.

    Constructing a ctranslate2 model on CUDA succeeds even when the CUDA runtime
    DLLs are missing; the failure only appears on the first compute. This warm-up
    forces that compute and is what makes `prepare` report the *actual* device.
    """
    import numpy as np  # noqa: PLC0415 - provided by faster-whisper

    segments, _info = model.transcribe(
        np.zeros(SAMPLE_RATE // 2, dtype="float32"),
        language=None,
        beam_size=1,
        vad_filter=False,
    )
    for _segment in segments:  # force the lazy generator: real GPU/CPU work
        pass


def load_model(name: str, device: str | None = None, compute_type: str | None = None):
    """Load (and download on first use) one model, falling back to CPU on CUDA failure."""
    global _model, _model_name, _loaded_device, _loaded_compute
    with _load_state:
        if _model is not None and _model_name == name:
            return _model
        _reset_model()

        if MODELS_DIR:
            os.makedirs(MODELS_DIR, exist_ok=True)
        cached = model_dir_hint(name)
        if cached is None:
            emit_progress("model", 0.35, f"Baixando modelo {name} do HuggingFace…")
            log(f"model {name} not cached under {MODELS_DIR!r}; downloading")
        else:
            emit_progress("model", 0.9, f"Modelo {name} já está no disco")
            log(f"model {name} found at {cached}")

        last_error: Exception | None = None
        attempts = _choose_attempts(device or DEVICE, compute_type or COMPUTE_TYPE)
        for index, (dev, ctype) in enumerate(attempts):
            started = time.perf_counter()
            emit_progress("load", 0.0 if index == 0 else 0.5, f"Carregando modelo em {dev.upper()} ({ctype})…")
            log(f"loading model={name} device={dev} compute_type={ctype} models_dir={MODELS_DIR!r}")
            try:
                from faster_whisper import WhisperModel  # noqa: PLC0415 - heavy import

                model = WhisperModel(
                    name,
                    device=dev,
                    compute_type=ctype,
                    download_root=MODELS_DIR or None,
                )
                emit_progress("load", 0.6, f"Testando inferência em {dev.upper()}…")
                _warmup(model)
                _model = model
                _model_name = name
                _loaded_device = dev
                _loaded_compute = ctype
                emit_progress("load", 1.0, f"Modelo carregado em {dev.upper()}")
                log(f"model ready device={dev} compute_type={ctype} in {time.perf_counter() - started:.2f}s")
                return model
            except Exception as exc:  # noqa: BLE001 - CUDA/cuDNN failures are expected
                last_error = exc
                log(f"load failed on {dev}/{ctype}: {exc!r}")
                _reset_model()
                if dev != "cpu":
                    log("CUDA compute unavailable (cuBLAS/cuDNN); falling back to CPU")
                    emit_progress("load", 0.3, "CUDA indisponível (cuBLAS/cuDNN); alternando para CPU…")
        raise RuntimeError(
            "não foi possível carregar o modelo Whisper; verifique rede/disco e, no caso de GPU, "
            f"CUDA/cuDNN. Último erro: {last_error}"
        )


# ── audio decoding ──────────────────────────────────────────────────────────
def decode_wav(wav_b64: str) -> tuple[Any, float]:
    """Decode validated base64 PCM16 16 kHz mono WAV into float32 samples."""
    import numpy as np  # noqa: PLC0415 - provided by faster-whisper

    try:
        raw = base64.b64decode(wav_b64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"áudio não é base64 válido: {exc}") from exc
    if not raw:
        raise ValueError("áudio vazio")
    try:
        with wave.open(io.BytesIO(raw), "rb") as reader:
            channels = reader.getnchannels()
            width = reader.getsampwidth()
            rate = reader.getframerate()
            frames = reader.readframes(reader.getnframes())
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"WAV inválido: {exc}") from exc
    if channels != 1 or width != 2 or rate != SAMPLE_RATE:
        raise ValueError(
            f"esperado WAV PCM16 mono {SAMPLE_RATE} Hz; recebido canais={channels} bits={width * 8} taxa={rate}"
        )
    if not frames:
        raise ValueError("WAV sem amostras")
    samples = np.frombuffer(frames, dtype=np.int16).astype("float32") / 32768.0
    return samples, len(samples) / float(SAMPLE_RATE)


# ── commands ────────────────────────────────────────────────────────────────
def cmd_status(req: dict) -> dict:
    """Report the worker environment without loading the model."""
    return {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "fasterWhisper": _version_of("faster_whisper"),
        "ctranslate2": _version_of("ctranslate2"),
        "onnxruntime": _version_of("onnxruntime"),
        "numpy": _version_of("numpy"),
        "cuda": cuda_info(),
        "loaded": _model is not None,
        "model": _model_name,
        "device": _loaded_device,
        "computeType": _loaded_compute,
        "modelsDir": MODELS_DIR,
        "idleSeconds": IDLE_SECONDS,
    }


def cmd_prepare(req: dict) -> dict:
    """Ensure the requested model is downloaded, loaded and actually usable."""
    name = str(req.get("model") or MODEL_NAME)
    started = time.perf_counter()
    had_cache = model_dir_hint(name) is not None
    load_model(name, req.get("device"), req.get("compute_type"))
    return {
        "model": _model_name,
        "device": _loaded_device,
        "computeType": _loaded_compute,
        "downloaded": not had_cache,
        "loadMs": int((time.perf_counter() - started) * 1000),
    }


def _run_transcribe(model, samples, language: str | None):
    """Run one transcription and force the lazy segment generator."""
    segments, info = model.transcribe(
        samples,
        language=language,
        beam_size=BEAM_SIZE,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,
        word_timestamps=False,
    )
    text = "".join(segment.text for segment in segments).strip()
    return text, info


def cmd_transcribe(req: dict) -> dict:
    """Transcribe one WAV request and report text, language and latency."""
    wav_b64 = req.get("wav_b64")
    if not isinstance(wav_b64, str) or not wav_b64:
        raise ValueError("wav_b64 ausente")
    language = req.get("language")
    if language in ("", "auto"):
        language = None
    name = str(req.get("model") or MODEL_NAME)
    samples, duration = decode_wav(wav_b64)
    started = time.perf_counter()
    log(f"transcribe start model={name} device={DEVICE if not _loaded_device else _loaded_device} duration={duration:.2f}s lang={language!r}")
    model = load_model(name, req.get("device"), req.get("compute_type"))
    try:
        text, info = _run_transcribe(model, samples, language)
    except Exception as exc:  # noqa: BLE001 - CUDA can break after a successful load
        if _loaded_device == "cuda":
            log(f"CUDA inference failed ({exc!r}); retrying once on CPU")
            _reset_model()
            model = load_model(name, "cpu", "int8")
            text, info = _run_transcribe(model, samples, language)
        else:
            raise
    inference_ms = int((time.perf_counter() - started) * 1000)
    log(f"transcribe model={_model_name} device={_loaded_device} duration={duration:.2f}s inference={inference_ms}ms chars={len(text)}")
    return {
        "text": text,
        "language": getattr(info, "language", None) or language,
        "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
        "durationSeconds": round(duration, 3),
        "inferenceMs": inference_ms,
        "model": _model_name,
        "device": _loaded_device,
        "computeType": _loaded_compute,
    }


COMMANDS = {
    "status": cmd_status,
    "prepare": cmd_prepare,
    "transcribe": cmd_transcribe,
}


def handle(line: str) -> bool:
    """Handle one protocol line; return False when the worker must exit."""
    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        fail(None, "bad-request", f"linha não é JSON: {exc}")
        return True
    if not isinstance(request, dict):
        fail(None, "bad-request", "mensagem deve ser um objeto JSON")
        return True
    req_id = request.get("id")
    command = request.get("cmd")
    if command == "shutdown":
        send({"id": req_id, "ok": True, "result": {"shutdown": True}})
        return False
    handler = COMMANDS.get(command) if isinstance(command, str) else None
    if handler is None:
        fail(req_id, "bad-request", f"comando desconhecido: {command!r}")
        return True
    try:
        result = handler(request)
        send({"id": req_id, "ok": True, "result": result})
    except ValueError as exc:
        fail(req_id, "bad-request", str(exc))
    except Exception as exc:  # noqa: BLE001 - protocol must stay alive
        log(f"command {command!r} failed: {exc!r}")
        fail(req_id, "internal", str(exc))
    return True


def main() -> int:
    """Run the JSON-Lines loop until shutdown, EOF, or the idle timeout."""
    log(
        f"starting worker python={sys.version.split()[0]} executable={sys.executable} "
        f"model={MODEL_NAME} device={DEVICE} compute_type={COMPUTE_TYPE} models_dir={MODELS_DIR!r} "
        f"idle={IDLE_SECONDS:.0f}s"
    )
    arm_idle()
    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            pause_idle()
            keep_running = True
            try:
                keep_running = handle(line)
            finally:
                if keep_running:
                    arm_idle()
            if not keep_running:
                log("shutdown requested")
                break
    except KeyboardInterrupt:
        log("interrupted")
    finally:
        pause_idle()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        os._exit(0)
