#!/usr/bin/env bash
# =====================================================================
#  DSH Voice Suite — setup-runtime.sh (Linux/macOS/WSL)
#
#  Equivalente POSIX do scripts/setup-runtime.ps1: cria/valida os venvs dos
#  plugins, instala dependências (runtime/requirements.txt do plugin quando
#  existir; senão fallback pinado), pré-baixa o modelo Whisper e valida
#  CUDA vs CPU — de forma idempotente, com logs e resumo final.
#
#  Uso:
#    ./scripts/setup-runtime.sh                       # both, modelo small
#    ./scripts/setup-runtime.sh --skip-model
#    ./scripts/setup-runtime.sh --tts-only
#    ./scripts/setup-runtime.sh --check               # só diagnostica (read-only)
#    ./scripts/setup-runtime.sh --voice-home /tmp/voice-home
#    ./scripts/setup-runtime.sh --model base
#
#  Saída: 0 = runtime pronto; 1 = falha crítica; 2 = erro de uso.
# =====================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VOICE_HOME="${DSH_VOICE_HOME:-$HOME/.dsh/dsh-voice}"
MODEL="small"
SKIP_MODEL=0
TARGET="both"
CHECK=0
PYTHON_PATH=""
STT_REQ_FALLBACK="faster-whisper==1.2.1"
TTS_REQ_FALLBACK="edge-tts==7.3.1"

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
while [ $# -gt 0 ]; do
  case "$1" in
    --model) shift; MODEL="${1:?--model exige valor}" ;;
    --skip-model) SKIP_MODEL=1 ;;
    --stt-only) TARGET="stt" ;;
    --tts-only) TARGET="tts" ;;
    --check) CHECK=1 ;;
    --voice-home) shift; VOICE_HOME="${1:?--voice-home exige path}" ;;
    --python) shift; PYTHON_PATH="${1:?--python exige path}" ;;
    -h|--help) usage ;;
    *) echo "[x] argumento desconhecido: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$TARGET" in both|stt|tts) : ;; *) echo "[x] --target inválido" >&2; exit 2 ;; esac
case "$MODEL" in tiny|base|small|medium|large-v3) : ;; *) echo "[x] --model inválido" >&2; exit 2 ;; esac

VOICE_HOME="$(cd "$VOICE_HOME" 2>/dev/null && pwd || echo "$VOICE_HOME")"
mkdir -p "$VOICE_HOME/logs" 2>/dev/null || true
LOG_FILE="$VOICE_HOME/logs/setup-runtime-$(date +%Y%m%d-%H%M%S).log"
touch "$LOG_FILE" 2>/dev/null || LOG_FILE=/dev/null
: > "$LOG_FILE" 2>/dev/null || true

FAILURES=0
declare -a SUMMARY=()
log()  { printf '%s\n' "$*" | tee -a "$LOG_FILE" >/dev/null; }
say()  { printf '%s\n' "$*"; log "$*"; }
ok()   { say "  [ok]   $*"; }
warn() { say "  [!]    $*"; }
err()  { say "  [x]    $*"; FAILURES=$((FAILURES + 1)); }
step() { say ""; say "== $*"; }

req_for() {
  # req_for <área> -> imprime caminho do requirements (plugin ou fallback gerado)
  local area="$1" plugin="$2" fallback="$3"
  local plugin_req="$REPO_ROOT/packages/$plugin/runtime/requirements.txt"
  if [ -f "$plugin_req" ]; then
    echo "$plugin_req"
    return 0
  fi
  local out="$VOICE_HOME/$area/requirements.fallback.txt"
  {
    echo "# Fallback gerado por scripts/setup-runtime.sh ($(date '+%F %T'))."
    echo "# O plugin ainda não forneceu packages/$plugin/runtime/requirements.txt."
    echo "$fallback"
  } > "$out"
  echo "$out"
}

find_base_python() {
  if [ -n "$PYTHON_PATH" ]; then
    if [ -x "$PYTHON_PATH" ]; then echo "$PYTHON_PATH"; return 0; fi
    return 1
  fi
  local var value
  for var in DSH_VOICE_PYTHON DSH_STT_PYTHON DSH_PYTHON; do
    value="$(printenv "$var" 2>/dev/null || true)"
    if [ -n "$value" ] && [ -x "$value" ]; then echo "$value"; return 0; fi
  done

  local candidates=() path_candidate
  local dsh_home="${DSH_HOME:-$HOME/.dsh}"
  # runtime do app DSH (detectado a partir de DSH_APP_ROOT) e runtime gerenciado
  if [ -n "${DSH_APP_ROOT:-}" ]; then
    for path_candidate in \
      "$DSH_APP_ROOT"/resources/runtime/*/dependencies/python/bin/python \
      "$DSH_APP_ROOT"/resources/runtime/*/dependencies/python/python.exe; do
      [ -x "$path_candidate" ] && candidates+=("$path_candidate")
    done
  fi
  for path_candidate in \
    "$dsh_home"/dsh-runtimes/*/dependencies/python/bin/python \
    "$dsh_home"/dsh-runtimes/*/dependencies/python/python.exe; do
    [ -x "$path_candidate" ] && candidates+=("$path_candidate")
  done
  local candidate
  for candidate in python3.12 python3.11 python3.10 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then candidates+=("$(command -v "$candidate")"); fi
  done
  local py
  for py in "${candidates[@]}"; do
    if "$py" -c 'import sys; raise SystemExit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)' >/dev/null 2>&1; then
      echo "$py"
      return 0
    fi
  done
  return 1
}

ensure_venv() {
  # ensure_venv <área> <venvdir> <basepython> -> ecoa caminho do python do venv
  local area="$1" venv="$2" base="$3"
  local vpython="$venv/bin/python"
  if [ -x "$vpython" ] && "$vpython" -c 'import sys; raise SystemExit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)' >/dev/null 2>&1; then
    ok "$area venv: $("$vpython" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') ($vpython)"
    echo "$vpython"
    return 0
  fi
  if [ -e "$venv" ]; then
    local backup="$venv.broken-$(date +%Y%m%d-%H%M%S)"
    warn "$area venv inválido; preservando como $backup e recriando"
    mv "$venv" "$backup" || { err "não consegui mover $venv"; return 1; }
  fi
  mkdir -p "$(dirname "$venv")"
  say "  criando venv $area em $venv"
  if ! "$base" -m venv "$venv" >>"$LOG_FILE" 2>&1; then
    err "python -m venv falhou para $area (veja $LOG_FILE)"
    return 1
  fi
  vpython="$venv/bin/python"
  if [ ! -x "$vpython" ]; then
    err "venv $area criado mas $vpython não existe"
    return 1
  fi
  ok "$area venv criado ($("$vpython" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])'))"
  echo "$vpython"
}

pip_install() {
  # pip_install <área> <vpython> <requirements>
  local area="$1" vpython="$2" req="$3"
  if ! "$vpython" -m pip --version >>"$LOG_FILE" 2>&1; then
    warn "$area: pip ausente; rodando ensurepip"
    "$vpython" -m ensurepip --upgrade >>"$LOG_FILE" 2>&1 || { err "$area: ensurepip falhou"; return 1; }
  fi
  say "  $area: pip install -r $(basename "$req") (pode demorar)"
  if "$vpython" -m pip install --disable-pip-version-check --no-input --timeout 120 --retries 3 -r "$req" >>"$LOG_FILE" 2>&1; then
    ok "$area: dependências instaladas ($(basename "$req"))"
    return 0
  fi
  err "$area: pip install falhou — veja $LOG_FILE (rede/PyPI ou versão pinada indisponível)"
  return 1
}

write_model_scripts() {
  local sttdir="$1"
  cat > "$sttdir/download-model.py" <<'PY'
"""Pré-baixa e carrega um modelo faster-whisper. Uso: python download-model.py <modelo> <dir>"""
import json
import sys
import time


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "uso: download-model.py <modelo> <dir>"}))
        return 2
    model_name, download_root = sys.argv[1], sys.argv[2]
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"import faster_whisper falhou: {exc}"}))
        return 1
    started = time.time()
    try:
        WhisperModel(model_name, device="cpu", compute_type="int8", download_root=download_root)
        print(json.dumps({"ok": True, "model": model_name, "loadSeconds": round(time.time() - started, 2)}))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
PY
  cat > "$sttdir/probe-cuda.py" <<'PY'
"""Diagnóstico CUDA/ctranslate2. Uso: python probe-cuda.py [modelo] [download_root]"""
import json
import sys


def main() -> int:
    out = {"version": None, "cudaDevices": None, "cudaLoadOk": None, "cudaLoadError": None}
    try:
        import ctranslate2
        out["version"] = getattr(ctranslate2, "__version__", "desconhecida")
        out["cudaDevices"] = int(ctranslate2.get_cuda_device_count())
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        print(json.dumps(out))
        return 0
    if len(sys.argv) >= 3 and out["cudaDevices"] > 0:
        try:
            from faster_whisper import WhisperModel
            WhisperModel(sys.argv[1], device="cuda", compute_type="float16", download_root=sys.argv[2])
            out["cudaLoadOk"] = True
        except Exception as exc:  # noqa: BLE001
            out["cudaLoadOk"] = False
            out["cudaLoadError"] = f"{type(exc).__name__}: {exc}"
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
}

model_present() {
  # model_present <modelsdir> : true se há algum model.bin (snapshot faster-whisper)
  if [ -d "$1" ] && find "$1" -name 'model.bin' -type f -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

# ======================= início =======================
say ""
say "=== DSH Voice Suite — setup-runtime.sh ==="
say "VoiceHome : $VOICE_HOME"
say "Repo      : $REPO_ROOT"
say "Target    : $TARGET | Modelo: $MODEL | SkipModel: $SKIP_MODEL | Check: $CHECK"
say "Log       : $LOG_FILE"
say ""

if [ -n "$PYTHON_PATH" ] && [ ! -x "$PYTHON_PATH" ]; then
  err "Python informado não é executável: $PYTHON_PATH"
  exit 1
fi

STT_DIR="$VOICE_HOME/stt"
TTS_DIR="$VOICE_HOME/tts"
MODELS_DIR="$STT_DIR/models"
if [ "$CHECK" -eq 0 ]; then
  mkdir -p "$STT_DIR/models" "$STT_DIR/logs" "$TTS_DIR/cache" "$TTS_DIR/logs" "$VOICE_HOME/logs"
fi

BASE_PYTHON="$(find_base_python || true)"
if [ -z "$BASE_PYTHON" ]; then
  err "nenhum Python 3.10-3.12 encontrado (use --python <path> ou defina DSH_VOICE_PYTHON)"
  exit 1
fi
ok "python base: $BASE_PYTHON ($("$BASE_PYTHON" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])'))"

STT_READY=0
TTS_READY=0

if [ "$TARGET" != "tts" ]; then
  step "STT (faster-whisper)"
  if [ "$CHECK" -eq 1 ]; then
    if [ -x "$STT_DIR/venv/bin/python" ]; then
      if "$STT_DIR/venv/bin/python" -c 'import faster_whisper' >/dev/null 2>&1; then
        ok "stt venv com faster-whisper: import ok"
      else
        err "faster-whisper não importa no venv do STT (rode sem --check)"
      fi
      if [ "$SKIP_MODEL" -eq 0 ]; then
        if model_present "$MODELS_DIR"; then ok "modelo $MODEL presente ($MODELS_DIR)"; else warn "modelo $MODEL não baixado"; fi
      else
        ok "modelo: --skip-model"
      fi
      STT_READY=1
    else
      err "stt venv ausente ($STT_DIR/venv)"
    fi
  else
    STT_PY="$(ensure_venv stt "$STT_DIR/venv" "$BASE_PYTHON" || true)"
    if [ -n "$STT_PY" ]; then
      REQ="$(req_for stt dsh-whisper-stt "$STT_REQ_FALLBACK")"
      say "  requirements: $REQ"
      pip_install stt "$STT_PY" "$REQ" && STT_READY=1
      write_model_scripts "$STT_DIR"
      if [ "$SKIP_MODEL" -eq 1 ]; then
        warn "modelo: pulado (--skip-model)"
      elif model_present "$MODELS_DIR"; then
        ok "modelo $MODEL já presente ($MODELS_DIR)"
      else
        say "  pré-baixando modelo $MODEL (CPU int8) — pode demorar"
        MODEL_JSON="$(timeout 1800 "$STT_PY" "$STT_DIR/download-model.py" "$MODEL" "$MODELS_DIR" 2>>"$LOG_FILE" | tail -n 1)"
        if printf '%s' "$MODEL_JSON" | grep -q '"ok": true'; then
          ok "modelo $MODEL pronto: $MODEL_JSON"
        else
          warn "modelo não baixado agora: $MODEL_JSON"
        fi
      fi
      if [ -x "$STT_DIR/venv/bin/python" ]; then
        if command -v nvidia-smi >/dev/null 2>&1; then
          say "  GPU: $(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -n 1)"
        fi
        CUDA_JSON="$("$STT_PY" "$STT_DIR/probe-cuda.py" "$MODEL" "$MODELS_DIR" 2>>"$LOG_FILE" | tail -n 1)"
        case "$CUDA_JSON" in
          *'"cudaLoadOk": true'*) ok "CUDA: load float16 ok ($CUDA_JSON)" ;;
          *'"cudaLoadOk": false'*) warn "CUDA indisponível (cuDNN?): CPU int8 é o fallback esperado ($CUDA_JSON)" ;;
          *) warn "CUDA não validado: $CUDA_JSON" ;;
        esac
      fi
    fi
  fi
fi

if [ "$TARGET" != "stt" ]; then
  step "TTS (edge-tts)"
  if [ "$CHECK" -eq 1 ]; then
    if [ -x "$TTS_DIR/venv/bin/python" ]; then
      if "$TTS_DIR/venv/bin/python" -c 'from importlib.metadata import version; print(version("edge-tts"))' >/dev/null 2>&1; then
        ok "tts venv com edge-tts: import ok"
      else
        err "edge-tts não importa no venv do TTS (rode sem --check)"
      fi
      TTS_READY=1
    else
      err "tts venv ausente ($TTS_DIR/venv)"
    fi
  else
    TTS_PY="$(ensure_venv tts "$TTS_DIR/venv" "$BASE_PYTHON" || true)"
    if [ -n "$TTS_PY" ]; then
      REQ="$(req_for tts dsh-tts "$TTS_REQ_FALLBACK")"
      say "  requirements: $REQ"
      if pip_install tts "$TTS_PY" "$REQ"; then
        if "$TTS_PY" -c 'from importlib.metadata import version; print(version("edge-tts"))' >/dev/null 2>&1; then
          ok "edge-tts import ok"
          TTS_READY=1
        else
          warn "edge-tts instalado mas não importa; synthesize pode cair para SAPI/browser"
        fi
      fi
    fi
  fi
fi

say ""
say "================ RESUMO setup-runtime ================"
say "  STT venv  : $([ "$STT_READY" -eq 1 ] && echo "pronto" || echo "não pronto")"
say "  TTS venv  : $([ "$TTS_READY" -eq 1 ] && echo "pronto" || echo "não pronto")"
say "  log       : $LOG_FILE"
say ""
say "Próximos passos:"
say "  - sincronizar lib/: node scripts/sync.mjs"
say "  - instalar no profile: ./scripts/install.sh (ou scripts/install.ps1 no Windows)"
say "  - subir dev server:    ./scripts/dev-server.ps1 (Windows) / dsh --profile voice-dev --port 3099 --no-open"
say "  - pipeline de QA:      pwsh -File tests/run-all.ps1"
say ""
if [ "$FAILURES" -gt 0 ]; then
  say "setup-runtime: $FAILURES falha(s) crítica(s)."
  exit 1
fi
say "setup-runtime: runtime pronto (avisos não impedem CPU/SAPI fallback)."
exit 0

