#!/bin/sh
# Run a POA-built Windows PE binary under wine64 (POA dev shell provides wine64).
# Used to runtime-verify compat-shim builds on Linux hosts without a Windows VM.
# Usage:  scripts/wine-verify.sh path/to/app.exe [args...]
set -eu
BIN="$1"; shift
if ! command -v wine64 >/dev/null 2>&1; then
  echo "wine64 not found — enter the POA dev shell (nix develop) or set PATH" >&2
  exit 127
fi
export WINEPREFIX="${WINEPREFIX:-/tmp/wineprefix}"
export WINEDEBUG=-all
exec wine64 "$BIN" "$@"
