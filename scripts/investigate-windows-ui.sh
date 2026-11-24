#!/usr/bin/env bash
# Visual RESEARCH ONLY. Wine is used to SEE the original Windows UI so the
# Linux port's look can be compared. It is NEVER part of the port, never
# packaged, and never used to run the delivered Linux binary.
set -euo pipefail
EXE="${1:?usage: investigate-windows-ui.sh <windows-exe> [screenshot.png]}"
SHOT="${2:-/home/nix/Projects/poa/.poa/windows-reference.png}"
PREFIX="$(mktemp -d /tmp/poa-wine-research.XXXXXX)"
export WINEPREFIX="$PREFIX"
export WINEDEBUG=-all
echo "Wine prefix (research only): $PREFIX"
echo "Investigating: $EXE"
wine "$EXE" &
WINE_PID=$!
sleep 20
import -window root "$SHOT" 2>/dev/null || true
kill "$WINE_PID" 2>/dev/null || true
wait "$WINE_PID" 2>/dev/null || true
echo "screenshot: $SHOT"
echo "NOTE: delete this prefix after research; it is not part of any POA port."
