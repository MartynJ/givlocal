#!/usr/bin/env python3
"""GivLocal - a local, cloud-free monitor for GivEnergy inverters / All-in-One.

Talks directly to the GivEnergy WiFi/LAN dongle on port 8899, logs to SQLite and
serves a dashboard at http://localhost:8080. Standard library only (Python 3.8+).

    python3 app.py --inverter 192.168.1.50
"""
import argparse, csv, io, json, logging, os, socket, sqlite3, threading, time, urllib.request, urllib.error
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from givproto import build_read, split_frames, decode_frame

HERE = os.path.dirname(os.path.abspath(__file__))
log = logging.getLogger("givlocal")

# (func, base, slave)  func 4 = input registers, 3 = holding registers.
# Input regs 0-59 carry nearly all live values, so they are asked for most often.
IR0 = (4, 0, 0x11)
ROTATION = [IR0, (4, 180, 0x11), IR0, (3, 0, 0x11), IR0, (4, 60, 0x32), IR0, (4, 120, 0x11)]
SAMPLE_EVERY = 30  # seconds between stored samples


def s16(v):
    return v - 0x10000 if v & 0x8000 else v


def u32(h, l):
    return (h << 16) | l


STATUS = {0: "Waiting", 1: "Normal", 2: "Warning", 3: "Fault", 4: "Updating firmware"}


def _latest(cache, func, base, slaves=None):
    hits = [v for k, v in cache.items() if k[0] == func and k[1] == base and (slaves is None or k[2] in slaves)]
    return max(hits, key=lambda v: v["ts"]) if hits else None


BATTERY_SLAVES = range(0x50, 0x58)  # AIO / HV battery modules


def decode_live(cache):
    """Turn cached register blocks into named values."""
    out = {}
    ir = _latest(cache, 4, 0, (0x11,)) or _latest(cache, 4, 0)
    if ir:
        r = ir["values"]
        out.update(
            status=STATUS.get(r[0], f"Unknown ({r[0]})"),
            v_ac=r[5] / 10, f_ac=r[13] / 100,
            p_pv=r[18] + r[20],
            p_inverter=s16(r[24]),
            p_grid=s16(r[30]),          # + export, - import
            p_eps=r[31],
            t_inverter=s16(r[41]) / 10,
            p_load=r[42],
            v_battery=r[50] / 100,
            i_battery=s16(r[51]) / 100,
            p_battery=s16(r[52]),       # + discharge, - charge
            t_battery=s16(r[56]) / 10,
            soc=r[59],
            e_pv_day=(r[17] + r[19]) / 10,
            e_export_day=r[25] / 10,
            e_import_day=r[26] / 10,
            e_charge_day=r[36] / 10,
            e_discharge_day=r[37] / 10,
            e_inverter_out_day=r[44] / 10,
            e_import_total=u32(r[32], r[33]) / 10,
            e_export_total=u32(r[21], r[22]) / 10,
            e_battery_throughput_total=u32(r[6], r[7]) / 10,
            fault_code=u32(r[39], r[40]),
            ts_live=ir["ts"],
        )
    modules = []
    for k in sorted(k for k in cache if k[:2] == (4, 60) and k[2] in BATTERY_SLAVES):
        v = cache[k]
        r = v["values"]
        cells = [x / 1000 for x in r[0:24] if 2000 < x < 4500]
        if not cells:
            continue
        temps = [s16(x) / 10 for x in r[30:42] if 0 < x < 800]
        modules.append({"serial": v["serial"], "address": f"0x{k[2]:02X}", "cells": cells, "temps": temps,
                        "voltage": round(sum(cells), 2), "ts": v["ts"]})
    if modules:
        out["modules"] = modules
    hr = _latest(cache, 3, 0, (0x11,))
    if hr:
        r = hr["values"]
        out["device_type"] = f"0x{r[0]:04X}"
        try:
            y, mo, d, h, mi, s = r[35:41]
            out["inverter_clock"] = f"{2000 + y:04d}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}:{s:02d}"
        except Exception:
            pass
    return out


# ---------------------------------------------------------------------------- storage
SAMPLE_COLS = ["soc", "p_battery", "p_grid", "p_load", "p_pv", "p_inverter", "v_ac", "f_ac",
               "v_battery", "t_battery", "t_inverter", "e_import_day", "e_export_day",
               "e_charge_day", "e_discharge_day", "e_pv_day"]


class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        with self.conn() as c:
            c.execute(f"""CREATE TABLE IF NOT EXISTS samples(
                ts INTEGER PRIMARY KEY, {', '.join(k + ' REAL' for k in SAMPLE_COLS)}, raw TEXT)""")
            if "uploaded" not in [r[1] for r in c.execute("PRAGMA table_info(samples)")]:
                c.execute("ALTER TABLE samples ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0")

    def conn(self):
        return sqlite3.connect(self.path, timeout=10)

    def add(self, ts, live, raw):
        with self.lock, self.conn() as c:
            c.execute(f"INSERT OR REPLACE INTO samples (ts, {', '.join(SAMPLE_COLS)}, raw) "
                      f"VALUES (?, {','.join('?' * len(SAMPLE_COLS))}, ?)",
                      [int(ts)] + [live.get(k) for k in SAMPLE_COLS] + [json.dumps(raw)])

    def pending_uploads(self, limit=200):
        with self.conn() as c:
            return c.execute("SELECT ts, raw FROM samples WHERE uploaded = 0 ORDER BY ts LIMIT ?", (limit,)).fetchall()

    def mark_uploaded(self, stamps):
        with self.lock, self.conn() as c:
            c.executemany("UPDATE samples SET uploaded = 1 WHERE ts = ?", [(t,) for t in stamps])

    def range(self, t0, t1):
        with self.conn() as c:
            cur = c.execute(f"SELECT ts, {', '.join(SAMPLE_COLS)} FROM samples WHERE ts>=? AND ts<? ORDER BY ts",
                            (int(t0), int(t1)))
            return [dict(zip(["ts"] + SAMPLE_COLS, row)) for row in cur]

    def days(self, n):
        start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=n - 1)
        rows = self.range(start.timestamp(), time.time() + 60)
        days = {}
        for r in rows:
            d = datetime.fromtimestamp(r["ts"]).strftime("%Y-%m-%d")
            days.setdefault(d, []).append(r)
        return [summarise(d, rs) for d, rs in sorted(days.items())]


def summarise(day, rows):
    """Daily totals: inverter day counters (max over the day) plus integrated house load."""
    def mx(k):
        vals = [r[k] for r in rows if r[k] is not None]
        return round(max(vals), 2) if vals else None
    load_kwh = 0.0
    for a, b in zip(rows, rows[1:]):
        dt = b["ts"] - a["ts"]
        if 0 < dt <= 600 and a["p_load"] is not None and b["p_load"] is not None:
            load_kwh += (a["p_load"] + b["p_load"]) / 2 * dt / 3600000
    socs = [r["soc"] for r in rows if r["soc"] is not None]
    return {"date": day, "import": mx("e_import_day"), "export": mx("e_export_day"),
            "charge": mx("e_charge_day"), "discharge": mx("e_discharge_day"), "pv": mx("e_pv_day"),
            "home": round(load_kwh, 2), "soc_min": min(socs) if socs else None,
            "soc_max": max(socs) if socs else None, "samples": len(rows),
            "coverage": round(min(1.0, len(rows) * SAMPLE_EVERY / 86400), 3)}


# ---------------------------------------------------------------------------- poller
class Poller(threading.Thread):
    """Keeps one connection to the dongle, answers heartbeats, keeps asking for
    register blocks and caches every reply whenever it turns up (this dongle can
    take a minute or more to answer)."""

    def __init__(self, host, port, store):
        super().__init__(daemon=True)
        self.host, self.port, self.store = host, port, store
        self.cache = {}
        self.adapter = None
        self.inverter = None
        self.stats = {"connected": False, "last_rx": None, "frames": 0, "replies": 0,
                      "requests": 0, "reconnects": 0, "last_error": None, "since": time.time()}
        self.lock = threading.Lock()
        self.last_sample = 0

    def snapshot(self):
        with self.lock:
            return dict(self.cache), dict(self.stats)

    def run(self):
        while True:
            try:
                self._session()
            except Exception as e:  # noqa
                self.stats["last_error"] = f"{type(e).__name__}: {e}"
                log.warning("connection problem: %s", e)
            self.stats["connected"] = False
            self.stats["reconnects"] += 1
            time.sleep(10)

    def _session(self):
        sock = socket.create_connection((self.host, self.port), timeout=10)
        sock.settimeout(0.5)
        self.stats["connected"] = True
        log.info("connected to %s:%s", self.host, self.port)
        buf, idx, outstanding, last_rx, last_tx = b"", 0, {}, time.time(), 0
        try:
            while True:
                now = time.time()
                # Pace requests: one in flight at a time, give up waiting after 20s.
                outstanding = {k: t for k, t in outstanding.items() if now - t < 20}
                if not outstanding and now - last_tx > 10:
                    func, base, slave = ROTATION[idx % len(ROTATION)]
                    idx += 1
                    sock.sendall(build_read(func, base, 60, slave, self.adapter))
                    outstanding[(func, base)] = now
                    log.debug("tx func=%s base=%s slave=0x%02x", func, base, slave)
                    last_tx = now
                    self.stats["requests"] += 1
                try:
                    chunk = sock.recv(8192)
                    if not chunk:
                        raise ConnectionError("dongle closed the connection")
                    buf += chunk
                    last_rx = now
                    self.stats["last_rx"] = now
                except socket.timeout:
                    pass
                if now - last_rx > 300:
                    raise TimeoutError("nothing received for 5 minutes")
                frames, buf = split_frames(buf)
                for fr in frames:
                    self.stats["frames"] += 1
                    m = decode_frame(fr)
                    log.debug("rx %s", {k: v for k, v in (m or {"raw": fr[:24].hex()}).items() if k != "values"})
                    if not m:
                        continue
                    if m["kind"] == "heartbeat":
                        self.adapter = m["adapter"]
                        sock.sendall(fr)  # echo keeps the dongle happy
                    elif m["kind"] == "read" and len(m["values"]) >= 60:
                        self.adapter = m["adapter"]
                        if m["slave"] == 0x11 and m["base"] == 0:
                            self.inverter = m["inverter"]
                        key = (m["func"], m["base"], m["slave"])
                        with self.lock:
                            self.cache[key] = {"ts": time.time(), "values": m["values"], "slave": m["slave"],
                                               "serial": m["inverter"]}
                            self.stats["replies"] += 1
                            self.stats["last_data"] = time.time()
                        outstanding.pop((m["func"], m["base"]), None)
                        if key[:2] == (4, 0):
                            log.info("live update from inverter %s", m["inverter"])
                            self._maybe_sample()
        finally:
            sock.close()

    def _maybe_sample(self):
        now = time.time()
        if now - self.last_sample < SAMPLE_EVERY:
            return
        cache, _ = self.snapshot()
        live = decode_live(cache)
        raw = {f"{k[0]}:{k[1]}:{k[2]}": {"values": v["values"], "serial": v.get("serial")}
               for k, v in cache.items() if now - v["ts"] < 600}
        self.store.add(now, live, raw)
        self.last_sample = now


# ---------------------------------------------------------------------------- upload
def reading_from_raw(ts, raw_json, inverter_serial):
    """Rebuild the decoded reading for a stored sample, in the shape the hosted dashboard accepts."""
    cache = {}
    for key, block in json.loads(raw_json or "{}").items():
        parts = [int(p) for p in key.split(":")]
        if len(parts) == 2:
            parts.append(0x11)
        values, serial = (block["values"], block.get("serial")) if isinstance(block, dict) else (block, None)
        cache[tuple(parts)] = {"ts": ts, "values": values, "slave": parts[2], "serial": serial or ""}
    live = decode_live(cache)
    if "soc" not in live:
        return None
    keep = SAMPLE_COLS + ["i_battery", "status", "fault_code", "e_import_total", "e_export_total",
                          "e_battery_throughput_total", "modules"]
    reading = {k: live[k] for k in keep if k in live}
    reading.update(ts=ts, inverter_serial=inverter_serial)
    return reading


class Uploader(threading.Thread):
    """Sends stored samples to the hosted dashboard, oldest first, and catches up after any gap."""

    def __init__(self, url, token, store, poller):
        super().__init__(daemon=True)
        self.url, self.token, self.store, self.poller = url, token, store, poller
        self.status = {"last_ok": None, "last_error": None, "sent": 0}

    def run(self):
        while True:
            try:
                self.flush()
            except Exception as e:  # noqa
                self.status["last_error"] = f"{type(e).__name__}: {e}"
                log.warning("upload failed: %s", e)
            time.sleep(30)

    def flush(self):
        while True:
            rows = self.store.pending_uploads()
            if not rows:
                return
            batch = [r for r in (reading_from_raw(ts, raw, self.poller.inverter) for ts, raw in rows) if r]
            if batch:
                req = urllib.request.Request(self.url, data=json.dumps(batch).encode(), method="POST", headers={
                    "Content-Type": "application/json", "X-Collector-Token": self.token})
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        result = json.loads(resp.read() or b"{}")
                except urllib.error.HTTPError as e:
                    raise RuntimeError(f"HTTP {e.code}: {e.read()[:200].decode(errors='replace')}")
                log.info("uploaded %s readings (%s new)", len(batch), result.get("stored"))
                self.status["sent"] += len(batch)
            self.store.mark_uploaded([ts for ts, _ in rows])
            self.status.update(last_ok=time.time(), last_error=None)


# ---------------------------------------------------------------------------- web
def make_handler(poller, store):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, body, ctype="application/json", code=200, extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body)
            if isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            if u.path in ("/", "/index.html"):
                with open(os.path.join(HERE, "static", "index.html"), "rb") as f:
                    return self.send(f.read(), "text/html; charset=utf-8")
            if u.path == "/chart.umd.min.js":
                with open(os.path.join(HERE, "static", "chart.umd.min.js"), "rb") as f:
                    return self.send(f.read(), "application/javascript")
            if u.path == "/api/live":
                cache, stats = poller.snapshot()
                return self.send({"now": time.time(), "live": decode_live(cache), "stats": stats,
                                  "inverter_serial": poller.inverter, "adapter_serial": poller.adapter,
                                  "host": poller.host})
            if u.path == "/api/day":
                d = datetime.strptime(q.get("date") or datetime.now().strftime("%Y-%m-%d"), "%Y-%m-%d")
                rows = store.range(d.timestamp(), (d + timedelta(days=1)).timestamp())
                return self.send({"date": d.strftime("%Y-%m-%d"), "rows": rows,
                                  "summary": summarise(d.strftime("%Y-%m-%d"), rows) if rows else None})
            if u.path == "/api/days":
                return self.send(store.days(int(q.get("n", 30))))
            if u.path == "/api/raw":
                cache, _ = poller.snapshot()
                return self.send({f"{k[0]}:{k[1]}:0x{k[2]:02x}": v for k, v in cache.items()})
            if u.path == "/api/export.csv":
                t1 = datetime.strptime(q["to"], "%Y-%m-%d") + timedelta(days=1) if "to" in q else datetime.now()
                t0 = datetime.strptime(q["from"], "%Y-%m-%d") if "from" in q else t1 - timedelta(days=30)
                rows = store.range(t0.timestamp(), t1.timestamp())
                s = io.StringIO()
                w = csv.writer(s)
                w.writerow(["time"] + SAMPLE_COLS)
                for r in rows:
                    w.writerow([datetime.fromtimestamp(r["ts"]).isoformat()] + [r[k] for k in SAMPLE_COLS])
                return self.send(s.getvalue(), "text/csv",
                                 extra={"Content-Disposition": 'attachment; filename="givlocal.csv"'})
            self.send({"error": "not found"}, code=404)
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inverter", default=os.environ.get("GIV_HOST", "192.168.1.50"))
    ap.add_argument("--inverter-port", type=int, default=8899)
    ap.add_argument("--port", type=int, default=8080, help="dashboard port")
    ap.add_argument("--bind", default="0.0.0.0", help="0.0.0.0 = visible to phones on your network")
    ap.add_argument("--db", default=os.path.join(HERE, "givlocal.db"))
    ap.add_argument("--upload-url", default=os.environ.get("GIV_UPLOAD_URL"),
                    help="hosted dashboard's ingest URL; readings are uploaded there as well as kept locally")
    ap.add_argument("--upload-token", default=os.environ.get("GIV_UPLOAD_TOKEN"))
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = Store(a.db)
    poller = Poller(a.inverter, a.inverter_port, store)
    poller.start()
    if a.upload_url:
        if not a.upload_token:
            ap.error("--upload-token is needed with --upload-url")
        Uploader(a.upload_url, a.upload_token, store, poller).start()
        log.info("uploading readings to %s", a.upload_url)
    srv = ThreadingHTTPServer((a.bind, a.port), make_handler(poller, store))
    log.info("dashboard on http://localhost:%s", a.port)
    srv.serve_forever()


if __name__ == "__main__":
    main()
