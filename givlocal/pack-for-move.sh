#!/bin/bash
# Run on the Mac that collects now, to hand over to another Mac.
#
#   ./pack-for-move.sh              stop collecting here and make GivLocal-move.zip on the Desktop
#   ./pack-for-move.sh --stop-only  just stop collecting here
#   ./pack-for-move.sh --resume     start collecting here again (if the move is called off)
#
# The zip holds the program, your history and the hosted-dashboard upload token. AirDrop it to
# the other Mac, unzip it there, run ./install-mac.sh inside it, then delete the zip from both.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
LIVE="${GIVLOCAL_DEST:-$HOME/Library/Application Support/GivLocal}"
LABEL="${GIVLOCAL_LABEL:-local.givlocal.collector}"
OUT="${GIVLOCAL_ZIP:-$HOME/Desktop/GivLocal-move.zip}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

stop() {
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && ok "Stopped collecting on this Mac" || ok "Wasn't collecting on this Mac"
    launchctl disable "$DOMAIN/$LABEL"   # stays stopped after a restart or log-in
}

case "${1:-}" in
    --resume)
        [[ -f "$PLIST" ]] || { warn "GivLocal was never installed on this Mac."; exit 1; }
        launchctl enable "$DOMAIN/$LABEL"
        for _ in 1 2 3 4 5 6; do
            launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break
            sleep 2
        done
        launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { warn "macOS wouldn't start it. Restart this Mac and try again."; exit 1; }
        ok "Collecting on this Mac again"
        exit 0 ;;
    --stop-only)
        stop
        exit 0 ;;
esac

echo "This stops the collector on this Mac and packs it up for the other one."
echo "Nothing is collected until the other Mac is running, so set it up straight away."
read -r -p "Continue? [Y/n] " r
[[ -z "$r" || "$r" =~ ^[Yy] ]] || exit 0

STAGE="$(mktemp -d)/GivLocal"
mkdir -p "$STAGE/static"
cp "$SRC"/app.py "$SRC"/givproto.py "$SRC"/start.sh "$SRC"/install-mac.sh "$SRC"/pack-for-move.sh "$STAGE"/
for f in README.md upload.conf.example; do if [[ -f "$SRC/$f" ]]; then cp "$SRC/$f" "$STAGE/"; fi; done
cp "$SRC"/static/* "$STAGE/static/"

stop

# Settings and history come from the installed copy if there is one, else from this folder.
DATA="$SRC"; [[ -f "$LIVE/givlocal.db" ]] && DATA="$LIVE"
if [[ -f "$DATA/upload.conf" ]]; then
    cp "$DATA/upload.conf" "$STAGE/" && chmod 600 "$STAGE/upload.conf" && ok "Upload settings included"
else
    warn "No upload.conf found; the other Mac won't upload to the hosted dashboard"
fi
if [[ -f "$DATA/givlocal.db" ]]; then
    # A proper SQLite copy, so nothing half-written is carried across.
    python3 -c 'import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()' "$DATA/givlocal.db" "$STAGE/givlocal.db"
    ok "History included ($(du -h "$STAGE/givlocal.db" | awk '{print $1}'))"
fi

rm -f "$OUT"
ditto -c -k --keepParent "$STAGE" "$OUT"
chmod 600 "$OUT"
rm -rf "$(dirname "$STAGE")"
ok "Made $OUT"
echo
echo "Next, on the other Mac:"
echo "  1. AirDrop GivLocal-move.zip to it and double-click the zip to unzip it."
echo "  2. Open Terminal and run:"
echo "       cd ~/Downloads/GivLocal && ./install-mac.sh"
echo "  3. Delete GivLocal-move.zip from both Macs. It contains your upload token."
echo
echo "To call the move off and collect here again:  ./pack-for-move.sh --resume"
