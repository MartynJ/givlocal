# GivLocal

A cloud-free replacement for the GivEnergy portal. It talks directly to the
GivEnergy WiFi dongle on your network, logs everything to a local SQLite file
and serves a dashboard in your browser.

- No GivEnergy account or internet connection needed
- Python 3.8+ standard library only (nothing to install)
- Changes one thing only: the grid-charge window (registers 94–95). Everything else is read-only

## Run

```bash
./start.sh
```

Then open <http://localhost:8080>. From a phone on the same WiFi, use
`http://<this-mac's-IP>:8080`.

Options: `python3 app.py --inverter 192.168.1.50 --port 8080 --db givlocal.db`

## Run it around the clock on a spare Mac

The collector only sees readings while it's running, so it's best on a Mac that
stays at home and never sleeps. A spare Apple silicon MacBook kept plugged in with
the lid shut works well, and uses about as much power as a Raspberry Pi.

On a fresh Mac, from this folder:

```bash
./install-mac.sh
```

It installs GivLocal in `~/Library/Application Support/GivLocal` and starts it at
every log-in. It then offers to keep the Mac awake with the lid shut, to stop macOS
installing updates by itself (which restarts the Mac), and to open Screen Sharing.
It also checks FileVault and gives battery advice. `./install-mac.sh --undo` stops
the collector and lets the Mac sleep normally again.

To move from the Mac that collects now, keeping your history and upload settings:

1. On the old Mac: `./pack-for-move.sh`. This stops collecting there and makes
   `GivLocal-move.zip` on the Desktop.
2. AirDrop the zip to the new Mac, unzip it, and run `./install-mac.sh` inside it.
3. Delete the zip from both Macs, because it contains your upload token.

`./pack-for-move.sh --resume` starts the old Mac collecting again if you change your mind.
Only one Mac should collect at a time.

## What you get

- Live power flow: grid, home, battery (plus solar, if the inverter reports any)
- Battery: charge %, power, voltage/current, temperatures, per-module cell voltages
- Today's import, export, battery charged and discharged, and home use
- Power and charge-level charts for any logged day
- Daily energy bars (7/30/90/365 days) with a table view and CSV export
- Inverter settings: battery mode, reserve, charge target and rate limits, grid-charge window, timed discharge and the inverter clock, with a warning when the charge window doesn't match your cheap-rate hours (`/api/settings?cheap_from=23:30&cheap_to=05:30`)

## How it works

The dongle (port 8899) polls the inverter and battery modules about every
5 minutes, the cycle it used for uploading to GivEnergy's cloud, and it copies
every reply to any connected client. GivLocal keeps one connection open, echoes
the dongle's heartbeats, also asks for registers itself, and caches every reply.
Live values therefore update roughly every 5 minutes.

Files:
- `app.py`: poller, register decoding, SQLite logging, web server
- `givproto.py`: GivEnergy local Modbus framing
- `static/index.html`: the dashboard
- `givlocal.db`: your history (back this file up)

Each stored sample also keeps the raw register values, so history can be
re-decoded later if a mapping turns out to be wrong.

Tip: give the inverter's Wi-Fi dongle a fixed IP in your router (a DHCP
reservation for its MAC address) so the address doesn't change.

## Changing the charge window

The Inverter settings panel can set the grid-charge window, for example to
23:30–05:30 for Intelligent Octopus Go. GivLocal only ever writes the two
registers listed in `WRITABLE` in `app.py`. A change is refused until the
current value has been read, is skipped if nothing would change, and counts as
done only when the inverter echoes the new value back. Every attempt is logged
in the `changes` table and shown under "Recent changes".

The dashboard has no sign-in, so anyone on your home network can use it.
Requests from other websites are blocked. Don't expose port 8080 to the internet.

To try it without touching a real inverter:

    python3 tests/fake_dongle.py 18899 &
    python3 app.py --inverter 127.0.0.1 --inverter-port 18899 --port 8099 --db /tmp/test.db
