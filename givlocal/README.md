# GivLocal

A cloud-free replacement for the GivEnergy portal. It talks directly to the
GivEnergy WiFi dongle on your network, logs everything to a local SQLite file
and serves a dashboard in your browser.

- No GivEnergy account or internet connection needed
- Python 3.8+ standard library only (nothing to install)
- Read-only: it never writes settings to the inverter

## Run

```bash
./start.sh
```

Then open <http://localhost:8080>. From a phone on the same WiFi, use
`http://<this-mac's-IP>:8080`.

Options: `python3 app.py --inverter 192.168.1.50 --port 8080 --db givlocal.db`

## What you get

- Live power flow: grid, home, battery (plus solar, if the inverter reports any)
- Battery: charge %, power, voltage/current, temperatures, per-module cell voltages
- Today's import, export, battery charged and discharged, and home use
- Power and charge-level charts for any logged day
- Daily energy bars (7/30/90/365 days) with a table view and CSV export
- Inverter settings (read-only): battery mode, reserve, charge target and rate limits, grid-charge window, timed discharge and the inverter clock, with a warning when the charge window doesn't match your cheap-rate hours (`/api/settings?cheap_from=23:30&cheap_to=05:30`)

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
