#!/usr/bin/env bash
# =====================================================================
#  DSH Voice Suite - instalador para Linux/macOS/WSL (parallel ao install.ps1)
#
#  Uso:
#    ./scripts/install.sh                  instala os dois plugins no profile voice-dev
#    ./scripts/install.sh --check          so verifica
#    ./scripts/install.sh --remove         remove os plugins do profile
#    ./scripts/install.sh --profile NAME   escolhe outro profile
#    DSH_CLI=/caminho/dsh ./scripts/install.sh
#
#  Faz o mesmo que install.ps1: usa `dsh plugin --profile X add -w <pkg>`,
#  valida pre-requisitos, sincroniza src->lib quando necessario e NUNCA
#  instala no profile 'desktop' nem reinicia servidores.
# =====================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE="voice-dev"
MODE="install"
PACKAGES=("dsh-whisper-stt" "dsh-tts")

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --remove) MODE="remove" ;;
    --dry-run) MODE="dry-run" ;;
    --profile) shift; PROFILE="${1:-}" ;;
    --stt-only) PACKAGES=("dsh-whisper-stt") ;;
    --tts-only) PACKAGES=("dsh-tts") ;;
    -h|--help) usage ;;
    *) echo "[x] argumento desconhecido: $1" >&2; exit 2 ;;
  esac
  shift
done

fail=0
ok()   { printf '[ok]   %s\n' "$*"; }
warn() { printf '[!]    %s\n' "$*"; }
err()  { printf '[x]    %s\n' "$*"; fail=$((fail+1)); }
info() { printf '       %s\n' "$*"; }

echo ""
echo "=== DSH Voice Suite - install.sh ==="
echo "Profile : $PROFILE"
echo "Repo    : $REPO_ROOT"
echo "Mode    : $MODE"
echo ""

if [ "$PROFILE" = "desktop" ]; then
  err "recusado: nunca instale no profile 'desktop'. Use 'voice-dev'."
  exit 1
fi

# Descoberta portátil do CLI dsh: DSH_CLI -> PATH -> npm global -> instalação do
# app Desktop (WSL /mnt/<drive>/, /opt, /Applications) -> powershell.exe (WSL).
DSH_CLI="${DSH_CLI:-}"
if [ -z "$DSH_CLI" ] && command -v dsh >/dev/null 2>&1; then
  DSH_CLI="$(command -v dsh)"
fi
if [ -z "$DSH_CLI" ]; then
  cli_candidates=()
  [ -n "${APPDATA:-}" ] && cli_candidates+=("$APPDATA/npm/dsh.cmd")
  cli_candidates+=(
    "$HOME/AppData/Roaming/npm/dsh.cmd"
    "$HOME/.npm-global/bin/dsh"
    "/usr/local/bin/dsh"
    "/usr/bin/dsh"
    "/usr/local/lib/node_modules/.bin/dsh"
  )
  [ -n "${DSH_APP_ROOT:-}" ] && cli_candidates+=(
    "$DSH_APP_ROOT/resources/runtime/cli/bin/dsh.cmd"
    "$DSH_APP_ROOT/resources/runtime/cli/bin/dsh"
  )
  for app_root in \
    /mnt/[a-z]/"DeepSeek Harness" \
    /opt/"DeepSeek Harness" \
    /opt/deepseek-harness \
    /Applications/"DeepSeek Harness.app/Contents/Resources"; do
    cli_candidates+=("$app_root/resources/runtime/cli/bin/dsh.cmd" "$app_root/resources/runtime/cli/bin/dsh" "$app_root/dsh.cmd" "$app_root/dsh")
  done
  for candidate in "${cli_candidates[@]}"; do
    if [ -n "$candidate" ] && [ -e "$candidate" ]; then DSH_CLI="$candidate"; break; fi
  done
fi
# Converte /mnt/<letra>/... (WSL) para <LETRA>:\... (cmd.exe). Outros caminhos ficam iguais.
winize_path() {
  case "$1" in
    /mnt/[a-z]/*)
      local letter rest
      letter="$(printf '%s' "$1" | cut -c6)"
      rest="$(printf '%s' "$1" | cut -d/ -f4- | tr '/' '\\')"
      printf '%s:\\%s\n' "$(printf '%s' "$letter" | tr '[:lower:]' '[:upper:]')" "$rest"
      ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# WSL: se o Windows tem `dsh` no PATH, usa o caminho Windows (cmd.exe executa .cmd).
if [ -z "$DSH_CLI" ] && command -v powershell.exe >/dev/null 2>&1; then
  win_path="$(powershell.exe -NoProfile -Command "(Get-Command dsh -ErrorAction SilentlyContinue).Source" 2>/dev/null | tr -d '\r' | head -n 1)"
  if [ -n "$win_path" ]; then DSH_CLI="$win_path"; fi
fi
# Caminho Windows (C:\...) pode não ser testável por `test -e` no WSL.
case "$DSH_CLI" in
  [A-Za-z]:[\\/]*) dsh_cli_exists=1 ;;
  *) dsh_cli_exists=0; [ -e "$DSH_CLI" ] && dsh_cli_exists=1 ;;
esac
if [ -z "$DSH_CLI" ] || [ "$dsh_cli_exists" -ne 1 ]; then
  err "CLI dsh nao encontrado."
  info "  - defina DSH_CLI=/caminho/para/dsh (ou dsh.cmd no WSL)"
  info "  - ou coloque 'dsh' no PATH"
  info "  - ou instale o app Desktop (procurei /mnt/*/DeepSeek Harness, /opt, /Applications)"
  exit 1
fi
ok "dsh CLI: $DSH_CLI"

if command -v node >/dev/null 2>&1; then
  ok "node: $(command -v node) ($(node --version))"
else
  err "node nao encontrado no PATH (Node.js 20+)."
fi

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
if [ -d "$PROFILE_DIR" ]; then
  ok "profile: $PROFILE_DIR"
else
  err "profile '$PROFILE' nao inicializado em $PROFILE_DIR"
fi

pkg_state=()
for pkg in "${PACKAGES[@]}"; do
  dir="$REPO_ROOT/packages/$pkg"
  if [ ! -f "$dir/package.json" ]; then
    err "pacote ausente: $dir/package.json"
    pkg_state+=("$pkg|missing")
    continue
  fi
  status="ok"
  if [ ! -f "$dir/lib/index.js" ] || [ ! -f "$dir/lib/client.js" ]; then
    status="nosync"
  fi
  pkg_state+=("$pkg|$status")
  if [ "$status" = "ok" ]; then ok "$pkg: package.json + lib/ ok"; else warn "$pkg: lib/ incompleto (src ainda nao sincronizado)"; fi
done

# estado do profile: procura dependencia no package.json
profile_has() {
  local pkg="$1"
  [ -f "$PROFILE_DIR/package.json" ] && grep -q "\"$pkg\"" "$PROFILE_DIR/package.json" 2>/dev/null
}

if [ "$MODE" = "check" ]; then
  missing=0
  for entry in "${pkg_state[@]}"; do
    pkg="${entry%%|*}"
    status="${entry##*|}"
    if [ "$status" = "missing" ]; then missing=$((missing+1)); continue; fi
    if profile_has "$pkg"; then ok "$pkg: instalado no profile"; else warn "$pkg: nao instalado no profile"; missing=$((missing+1)); fi
  done
  echo ""
  if [ "$missing" -gt 0 ]; then
    echo "install --check: $missing problema(s)." >&2
    exit 1
  fi
  echo "install --check: OK"
  exit 0
fi

if [ "$fail" -gt 0 ]; then
  echo ""
  echo "install: $fail erro(s) de pre-requisito; abortando." >&2
  exit 1
fi

# Sincroniza lib/ se necessario (o lib e o que roda).
for entry in "${pkg_state[@]}"; do
  pkg="${entry%%|*}"
  status="${entry##*|}"
  if [ "$status" = "nosync" ]; then
    echo "-> sync $pkg"
    (cd "$REPO_ROOT" && node scripts/sync.mjs --package "$pkg") || err "sync de $pkg falhou"
  fi
done
if [ "$fail" -gt 0 ]; then exit 1; fi

commands=()
for pkg in "${PACKAGES[@]}"; do
  if [ ! -f "$REPO_ROOT/packages/$pkg/package.json" ]; then continue; fi
  if [ "$MODE" = "remove" ]; then
    commands+=("plugin --profile $PROFILE remove $pkg")
  else
    commands+=("plugin --profile $PROFILE add -w $REPO_ROOT/packages/$pkg")
  fi
done

if [ "$MODE" = "dry-run" ]; then
  echo ""
  echo "--- comandos (dry-run) ---"
  for c in "${commands[@]}"; do echo "  \"$DSH_CLI\" $c"; done
  exit 0
fi

echo ""
echo "--- ${MODE} no profile '$PROFILE' (hot apply se o servidor estiver rodando) ---"
for c in "${commands[@]}"; do
  # shellcheck disable=SC2086
  display="$DSH_CLI $c"
  echo "-> $display"
  # dsh.cmd no WSL precisa de cmd.exe; no Linux nativo e um script shell.
  if [[ "$DSH_CLI" == *.cmd ]]; then
    # shellcheck disable=SC2086
    cmd.exe //c "$(winize_path "$DSH_CLI")" $c
    code=$?
  else
    # shellcheck disable=SC2086
    "$DSH_CLI" $c
    code=$?
  fi
  if [ "$code" -ne 0 ]; then
    err "comando falhou (exit $code)"
  elif [ "$MODE" = "remove" ]; then
    ok "removido: $pkg"
  else
    ok "instalado"
  fi
done

echo ""
if [ "$fail" -gt 0 ]; then
  echo "install: $fail falha(s)." >&2
  exit 1
fi
echo "install: concluido. Se o profile ja estava rodando, apenas recarregue a pagina (nao reinicie o servidor)."
echo "Proximos passos:"
echo "  - Runtime Python: pwsh -File scripts/setup-runtime.ps1"
echo "  - QA: pwsh -File tests/run-all.ps1"
exit 0

