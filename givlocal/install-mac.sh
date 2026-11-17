#!/bin/bash
# Install GivLocal on this Mac and keep it running around the clock, for example on a
# MacBook kept plugged in with the lid shut.
#
#   ./install-mac.sh          install (or update) and start the collector, then set up the Mac
#   ./install-mac.sh --undo   stop the collector and let the Mac sleep normally again
#
# Run it from the folder that holds app.py: a GivLocal-move.zip made by pack-for-move.sh,
# or a copy of the givlocal folder from GitHub. It is safe to run again.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
# The overrides below exist only so the script can be tested without touching a real install.
DEST="${GIVLOCAL_DEST:-$HOME/Library/Application Support/GivLocal}"
LABEL="${GIVLOCAL_LABEL:-local.givlocal.collector}"
EXTRA_ARGS="${GIVLOCAL_ARGS:-}"
SKIP_SYSTEM="${GIVLOCAL_SKIP_SYSTEM:-}"
PORT="${GIV_PORT:-8080}"
INVERTER="${GIV_HOST:-192.168.1.50}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

title() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  ✓ %s\n' "$*"; }
warn()  { printf '  ! %s\n' "$*"; }
yes()   { local r; read -r -p "  $1 [Y/n] " r; [[ -z "$r" || "$r" =~ ^[Yy] ]]; }

if [[ "${1:-}" == "--undo" ]]; then
    title "Stopping GivLocal"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && ok "Collector stopped" || ok "Collector wasn't running"
    rm -f "$PLIST"
    if [[ -z "$SKIP_SYSTEM" ]]; then
        sudo pmset -a disablesleep 0 && ok "The Mac sleeps normally again, including when the lid is shut"
    fi
    echo "  Your history is still in: $DEST"
    exit 0
fi

title "Checking this Mac"
[[ "$(uname)" == "Darwin" ]] || { warn "This script is for macOS."; exit 1; }
for f in app.py givproto.py start.sh static/index.html; do
    [[ -f "$SRC/$f" ]] || { warn "$f is missing. Run this from the GivLocal folder."; exit 1; }
done
if ! xcode-select -p >/dev/null 2>&1; then
    warn "Python needs Apple's Command Line Tools. An installer window is opening now."
    warn "When it has finished, run ./install-mac.sh again."
    xcode-select --install 2>/dev/null || true
    exit 1
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || { warn "Python 3.8 or newer is needed."; exit 1; }
ok "macOS $(sw_vers -productVersion), $(python3 --version)"

if nc -z -G 3 "$INVERTER" 8899 2>/dev/null; then
    ok "Inverter dongle answers at $INVERTER"
else
    warn "Nothing answered at $INVERTER port 8899. Is this Mac on the home Wi-Fi?"
    yes "Install anyway?" || exit 1
fi

title "Installing to $DEST"
if launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; then
    # macOS finishes stopping a service in the background; starting it again too soon fails.
    for _ in $(seq 1 30); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
    ok "Stopped the running copy to update it"
fi
mkdir -p "$DEST/static"
cp "$SRC"/app.py "$SRC"/givproto.py "$SRC"/start.sh "$DEST"/
if [[ -f "$SRC/README.md" ]]; then cp "$SRC/README.md" "$DEST/"; fi
cp "$SRC"/static/* "$DEST/static/"
chmod +x "$DEST/start.sh"
ok "Program files copied"

if [[ -f "$DEST/givlocal.db" ]]; then
    ok "Kept the history already on this Mac"
elif [[ -f "$SRC/givlocal.db" ]]; then
    cp "$SRC/givlocal.db" "$DEST/" && ok "History copied ($(du -h "$SRC/givlocal.db" | awk '{print $1}'))"
else
    ok "No history to copy; a new one starts now"
fi

if [[ -f "$DEST/upload.conf" ]]; then
    ok "Kept the hosted-dashboard settings already on this Mac"
elif [[ -f "$SRC/upload.conf" ]]; then
    cp "$SRC/upload.conf" "$DEST/" && chmod 600 "$DEST/upload.conf"
    ok "Hosted-dashboard upload settings copied"
else
    warn "No upload.conf, so readings stay on this Mac only (see upload.conf.example)"
fi

title "Starting the collector"
args=""
for a in $EXTRA_ARGS; do args="$args<string>$a</string>"; done
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$DEST/start.sh</string>$args</array>
  <key>EnvironmentVariables</key>
  <dict><key>GIV_HOST</key><string>$INVERTER</string></dict>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DEST/givlocal.log</string>
  <key>StandardErrorPath</key><string>$DEST/givlocal.log</string>
</dict>
</plist>
EOF
launchctl enable "$DOMAIN/$LABEL"
started=""
for _ in 1 2 3 4 5 6; do
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
        started=1; break
    fi
    sleep 2
done
if [[ -z "$started" ]]; then
    warn "macOS wouldn't start the collector. Restart this Mac, log in and run ./install-mac.sh again."
    exit 1
fi
up=""
for _ in $(seq 1 20); do
    curl -s -o /dev/null -m 2 "http://localhost:$PORT/api/live" && { up=1; break; }
    sleep 1
done
if [[ -n "$up" ]]; then
    ok "Running, and it starts by itself whenever you log in"
else
    warn "The dashboard didn't answer. The last lines of the log:"
    tail -5 "$DEST/givlocal.log" | sed 's/^/    /'
    exit 1
fi

if [[ -n "$SKIP_SYSTEM" ]]; then
    title "Skipped the Mac settings (test run)"
    exit 0
fi

title "Keeping the Mac awake"
echo "  A MacBook normally sleeps when the lid is shut, which would stop the collector."
echo "  This turns sleep off completely until you run ./install-mac.sh --undo."
echo "  The screen still turns off. macOS will ask for your login password."
if yes "Keep this Mac awake, even with the lid shut?"; then
    sudo pmset -a disablesleep 1
    sudo pmset -c sleep 0 womp 1 2>/dev/null || true
    sudo pmset -a autorestart 1 2>/dev/null || true
    ok "Sleep turned off"
else
    warn "Left as it is. The collector stops whenever the Mac sleeps."
fi

title "Automatic updates"
echo "  If macOS installs an update by itself, it restarts. With FileVault on, it then waits"
echo "  at the password screen and the collector doesn't run until someone logs in."
auto=$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo 1)
if [[ "$auto" == "0" ]]; then
    ok "macOS updates already need your go-ahead"
elif yes "Download updates but wait for you to install them?"; then
    sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
    ok "Updates download, then wait for you. Install them now and then from System Settings."
fi

title "Restarts and FileVault"
if fdesetup status 2>/dev/null | grep -q "On"; then
    warn "FileVault is on, so after a restart the Mac waits for your password before collecting."
    echo "    To restart it yourself without that, run:  sudo fdesetup authrestart"
else
    ok "FileVault is off, so it can start collecting after a restart once you're logged in."
    echo "    (Turn on automatic login in System Settings → Users & Groups if it should log in by itself.)"
fi

title "Battery"
pct=$(pmset -g batt | grep -Eo '[0-9]+%' | head -1 || true)
if [[ -n "$pct" ]]; then
    echo "  Battery is at $pct. Kept at 100% on the charger for months, a battery wears and can swell."
    echo "  Cap it at about 80%: use the charge limit in System Settings → Battery if your macOS has"
    echo "  one, or the free app AlDente. Leave the lid shut somewhere with airflow, not in a drawer."
else
    ok "No battery (a desktop Mac), nothing to do"
fi

title "Remote access"
echo "  Screen Sharing lets you check on this Mac from your other one without opening the lid."
if yes "Open Sharing settings now to turn on Screen Sharing?"; then
    open "x-apple.systempreferences:com.apple.Sharing-Settings.extension" || true
    echo "    Turn on Screen Sharing. Then connect from your other Mac in Finder → Network."
fi

ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "this-mac")
title "Done"
echo "  Local dashboard:  http://$ip:$PORT   (from any phone or computer on your home network)"
echo "  Log file:         $DEST/givlocal.log"
echo "  Only one Mac should collect at a time. If your old Mac still does, run"
echo "  ./pack-for-move.sh --stop-only there, or ./install-mac.sh --undo."
