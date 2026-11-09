# GivLocal on Anbaric

The hosted half of GivLocal: a dashboard for a GivEnergy All-in-One that no longer
depends on GivEnergy's cloud. The inverter is only reachable on the home network, so
the collector in `../givlocal` reads it there and uploads each reading here.

Live at https://givlocal.staging.cloud.anbaric.ai (sign in with your Anbaric account).

## State machines

| Machine | Lifecycle |
|---|---|
| `energy-days` | one job per day: `recording` (awaits the home collector) → `closing` (totals the day from stored readings) → `complete` |
| `alerts` | `open` (awaits a person to acknowledge) → `acknowledged` (awaits the condition clearing) → `resolved`; resolves straight from `open` if the problem goes away first |
| `health-checks` | runs at :07 every hour: raises/clears alerts from the latest reading (including "collector offline") and closes any day that has ended |

Alerts are raised for: no readings for 20 minutes, an inverter fault, a battery cell
spread over 100 mV, and battery temperature outside 2–45 °C.

## Storage and access

- Readings: SQL store table `givlocal_readings` (Postgres when deployed).
- Upload token: secret store `givlocal-collector-token`, created on first start and shown
  on the dashboard's "Home collector" panel to signed-in members.
- The app is **public** (Manage apps → Access) so the collector can reach `POST /ingest`,
  which requires the `X-Collector-Token` header. Every other page and API requires a
  signed-in member; signed-out visitors are sent to `/login`.

## Run locally

```bash
npm install
npx tsx src/main.ts                      # in-memory; http://localhost:3000
npx tsx test/healthCheck.check.ts        # drives the health-check machine end to end
```

## Deploy

```bash
anbaric app deploy
```
