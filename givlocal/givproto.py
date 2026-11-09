"""Minimal GivEnergy local Modbus (TCP port 8899) protocol helpers. Standard library only.

Wire format (reverse-engineered by the givenergy-modbus / GivTCP community):
  MBAP-ish header: tid=0x5959, pid=0x0001, len, uid=0x01, fid
  fid=0x01 -> heartbeat from dongle; must be echoed back
  fid=0x02 -> transparent frame:
     adapter serial(10) pad(8) slave(1) func(1) [request: base(2) count(2) crc(2)]
                                               [response: inverter serial(10) base(2) count(2) values(2n) crc(2)]
"""
import struct

HEADER = struct.Struct(">HHHBB")


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def build_read(func: int, base: int, count: int, slave: int, adapter_serial: str) -> bytes:
    serial = (adapter_serial or "AB1234G567")[-10:].rjust(10, "*").encode()
    body = serial + struct.pack(">QBBHH", 8, slave, func, base, count)
    body += struct.pack(">H", crc16_modbus(struct.pack(">BHH", func, base, count)))
    return HEADER.pack(0x5959, 1, len(body) + 2, 1, 2) + body


def split_frames(buf: bytes):
    """Split a byte stream into complete frames. Returns (frames, leftover)."""
    frames = []
    while True:
        i = buf.find(b"\x59\x59\x00\x01")
        if i < 0:
            return frames, buf[-3:]
        buf = buf[i:]
        if len(buf) < 8:
            return frames, buf
        _, _, ln, _, _ = HEADER.unpack(buf[:8])
        total = 6 + ln
        if ln < 2 or ln > 1000:
            buf = buf[4:]
            continue
        if len(buf) < total:
            return frames, buf
        frames.append(buf[:total])
        buf = buf[total:]


def decode_frame(frame: bytes):
    """Return dict describing a frame, or None if not understood."""
    fid = frame[7]
    if fid == 1:
        return {"kind": "heartbeat", "adapter": frame[8:18].decode(errors="replace")}
    if fid != 2 or len(frame) < 8 + 34:
        return None
    p = frame[8:]
    adapter = p[0:10].decode(errors="replace")
    slave, func = p[18], p[19]
    if func & 0x80 or func not in (3, 4):
        return {"kind": "other", "func": func, "slave": slave, "adapter": adapter}
    inverter = p[20:30].decode(errors="replace")
    base, count = struct.unpack(">HH", p[30:34])
    if count > 125 or len(p) < 34 + 2 * count:
        return None
    values = list(struct.unpack(f">{count}H", p[34:34 + 2 * count]))
    return {"kind": "read", "func": func, "slave": slave, "base": base, "values": values,
            "adapter": adapter, "inverter": inverter}
