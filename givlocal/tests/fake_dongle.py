"""Stand-in GivEnergy dongle for testing GivLocal without touching a real inverter.

    python3 tests/fake_dongle.py [port] [--refuse]

Answers reads with plausible registers and echoes writes (or refuses them with --refuse)."""
import socket, struct, sys, threading, time
sys.path.insert(0, __import__("os").path.dirname(__file__) + "/..")
from givproto import HEADER, crc16_modbus, split_frames

ADAPTER, INVERTER = b"WF0000T001", b"CE0000T001"
REFUSE = "--refuse" in sys.argv
regs = {(3, i): 0 for i in range(0, 360)}
regs.update({(3, 27): 1, (3, 94): 0, (3, 95): 530, (3, 96): 1, (3, 110): 4, (3, 111): 50, (3, 112): 50, (3, 116): 100})


def frame(slave, func, payload):
    body = ADAPTER + b"\0" * 8 + bytes([slave, func]) + payload
    body += struct.pack(">H", crc16_modbus(body[18:]))
    return HEADER.pack(0x5959, 1, len(body) + 2, 1, 2) + body


def handle(conn):
    conn.sendall(HEADER.pack(0x5959, 1, 13, 1, 1) + ADAPTER + b"\x01")  # heartbeat
    buf = b""
    while True:
        data = conn.recv(4096)
        if not data:
            return
        frames, buf = split_frames(buf + data)
        for fr in frames:
            if fr[7] != 2:
                continue
            p = fr[8:]
            slave, func, a, b = p[18], p[19], *struct.unpack(">HH", p[20:24])
            time.sleep(0.3)
            if func == 6:
                if REFUSE:
                    conn.sendall(frame(slave, 0x86, INVERTER + b"\x02"))
                else:
                    regs[(3, a)] = b
                    conn.sendall(frame(slave, 6, INVERTER + struct.pack(">HH", a, b)))
            elif func in (3, 4):
                vals = [regs.get((func, a + i), 0) for i in range(b)]
                if func == 4 and a == 0:
                    vals[59] = 80
                conn.sendall(frame(slave, func, INVERTER + struct.pack(f">HH{b}H", a, b, *vals)))


port = int(next((x for x in sys.argv[1:] if x.isdigit()), 18899))
srv = socket.create_server(("127.0.0.1", port))
print("fake dongle on", port, flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
