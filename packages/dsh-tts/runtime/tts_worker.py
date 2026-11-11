#!/usr/bin/env python3
"""dsh-tts Edge neural voice worker (JSON Lines over stdin/stdout).

Protocol (one JSON object per line, UTF-8):

  request   {"id": 1, "cmd": "ping"}
  response  {"id": 1, "ok": true, "result": {"version": "..."}}

  request   {"id": 2, "cmd": "voices"}
  response  {"id": 2, "ok": true, "result": {"voices": ["pt-BR-...", ...]}}

  request   {"id": 3, "cmd": "synthesize", "text": "...", "voice": "pt-BR-FranciscaNeural",
             "rate": "+0%", "pitch": "+0Hz", "out": "C:\\...\\file.mp3"}
  response  {"id": 3, "ok": true, "result": {"path": "...", "bytes": 12345}}

  request   {"id": 4, "cmd": "shutdown"}
  response  {"id": 4, "ok": true, "result": {"bye": true}}

  error     {"id": 3, "ok": false, "error": {"code": "NoAudioReceived", "message": "..."}}

Diagnostics go to stderr only; stdout carries JSON lines exclusively so the
host can parse it without a framing protocol.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import traceback

try:  # Windows console default encoding would mangle non-Latin text.
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - non-reconfigurable stream
    pass


def log(message: str) -> None:
    """Write one diagnostic line to stderr (never stdout)."""
    try:
        sys.stderr.write(str(message) + "\n")
        sys.stderr.flush()
    except Exception:  # pragma: no cover
        pass


def emit(payload: dict) -> None:
    """Write exactly one JSON line to stdout and flush."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class EdgeEngine:
    """Lazy edge-tts adapter; imports the package only when first needed."""

    def __init__(self) -> None:
        self._module = None

    @property
    def module(self):
        if self._module is None:
            import edge_tts  # noqa: PLC0415 - deliberate lazy import

            self._module = edge_tts
        return self._module

    def version(self) -> str:
        try:
            return str(getattr(self.module, "__version__", "unknown"))
        except Exception:
            return "unknown"

    def list_voices(self) -> list[str]:
        async def run() -> list[str]:
            voices = await self.module.list_voices()
            return sorted({str(item.get("ShortName", "")) for item in voices if item.get("ShortName")})

        return asyncio.run(run())

    def synthesize(self, text: str, voice: str, rate: str, pitch: str, out: str) -> int:
        """Render `text` to an MP3 file at `out`; return the byte size.

        The Edge read-aloud endpoint occasionally answers a transient 403/503
        handshake (observed in this environment with an outdated DRM token and
        under network hiccups): one retry with a short backoff turns that into
        a normal request again, while the host keeps its SAPI fallback for a
        persistent outage.
        """

        async def run() -> None:
            communicate = self.module.Communicate(text, voice, rate=rate, pitch=pitch)
            await communicate.save(out)

        last_error: Exception | None = None
        for attempt in range(1, 3):
            try:
                # edge-tts 7.x keeps no loop; a fresh loop per request is correct
                # here and sidesteps "event loop is closed" reuse problems.
                asyncio.run(run())
                if not os.path.exists(out):
                    raise RuntimeError("edge-tts produced no output file")
                size = os.path.getsize(out)
                if size <= 0:
                    raise RuntimeError("edge-tts produced an empty output file")
                return size
            except Exception as error:  # transient handshake/network failure
                last_error = error
                log(f"synthesize attempt {attempt} failed: {error}")
                try:
                    os.remove(out)
                except OSError:
                    pass
                if attempt < 2:
                    time.sleep(0.9)
        raise last_error if last_error is not None else RuntimeError("edge-tts failed")


def handle(engine: EdgeEngine, request: dict) -> dict:
    """Dispatch one request object and return its response object."""
    request_id = request.get("id")
    command = request.get("cmd")

    if command == "ping":
        return {"id": request_id, "ok": True, "result": {"version": engine.version()}}

    if command == "voices":
        return {"id": request_id, "ok": True, "result": {"voices": engine.list_voices()}}

    if command == "synthesize":
        text = request.get("text")
        voice = request.get("voice")
        out = request.get("out")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("synthesize requires a non-empty text")
        if not isinstance(voice, str) or not voice:
            raise ValueError("synthesize requires a voice")
        if not isinstance(out, str) or not out:
            raise ValueError("synthesize requires an output path")
        rate = request.get("rate") or "+0%"
        pitch = request.get("pitch") or "+0Hz"
        size = engine.synthesize(text, voice, str(rate), str(pitch), out)
        return {"id": request_id, "ok": True, "result": {"path": out, "bytes": size}}

    if command == "shutdown":
        return {"id": request_id, "ok": True, "result": {"bye": True}}

    raise ValueError(f"unknown command: {command!r}")


def main() -> int:
    engine = EdgeEngine()
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            response = handle(engine, request)
        except Exception as error:  # keep serving after one failed request
            log(traceback.format_exc())
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": {
                    "code": type(error).__name__,
                    "message": str(error) or type(error).__name__,
                },
            }
        emit(response)
        if isinstance(request, dict) and request.get("cmd") == "shutdown":
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
