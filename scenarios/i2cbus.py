"""A fake I2C bus for fppd (fakei2c.c): chips that answer at chosen
addresses, and every write fppd puts on the bus, to read back."""

import os

import shims


class Bus:
    def __init__(self, fppd, devices, fail=(), noprobe=()):
        """devices: the addresses with a chip; fail: (addr, reg) register
        reads that fail with EIO; noprobe: chips that NAK a plain byte read
        (fpp's probe for a chip) but take writes."""
        self.out = os.path.join(fppd.media, "logs", "i2c-writes.txt")
        self.env = {
            "FAKEI2C_DEVICES": ",".join(hex(a) for a in devices),
            "FAKEI2C_OUT": self.out,
            "FAKEI2C_FAIL": ",".join(f"{hex(a)}:{hex(r)}" for a, r in fail),
            "FAKEI2C_NOPROBE": ",".join(hex(a) for a in noprobe),
        }

    def start(self, fppd, **kw):
        """fppd.start() with the bus preloaded."""
        return fppd.start(preload=[shims.build("fakei2c.c")], extra_env=self.env, **kw)

    def writes(self, addr=None):
        """[(ms, addr, reg, data bytes)], reg None for a register-less byte
        write, oldest first."""
        try:
            with open(self.out) as f:
                rows = [l.split() for l in f if l.endswith("\n")]
        except FileNotFoundError:
            return []
        out = []
        for r in rows:
            a = int(r[1], 16)
            if addr is None or a == addr:
                out.append((int(r[0]), a, None if r[2] == "-" else int(r[2], 16),
                            bytes.fromhex(r[3]) if len(r) > 3 else b""))
        return out

    def registers(self, addr):
        """Each register's last written value, as the chip holds it."""
        regs = {}
        for _, _, reg, data in self.writes(addr):
            if reg is None:
                regs[None] = data[0]
                continue
            for i, b in enumerate(data):
                regs[(reg + i) & 0xFF] = b
        return regs
