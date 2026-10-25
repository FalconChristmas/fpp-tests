"""I2CUtils, the I2C helper fppd's outputs and native plugins write to
chips with, on a fake I2C bus (fakei2c.c, i2cbus.py): called from a native
plugin (nativeplugin.cpp's NATIVE_I2C), the way an output plugin calls it.

The bus answers for /dev/i2c-N whether or not the machine has one, so this
runs in Docker as well as under run-local.sh on a device.
"""

from i2cbus import Bus
from native_plugin import install

CHIP = 0x40


def raw(fppd, count, reg=0x06):
    return str(fppd.command("Native Test I2C Raw", "1", hex(CHIP), hex(reg), str(count)))


def test_a_raw_block_write_too_big_for_one_message_is_refused(fppd):
    """writeRawI2CBlockData() with 256 bytes puts the register and all 256
    on the bus in one message; with 300, or a negative count, it returns
    -1 and puts nothing on the bus, and fppd carries on.

    Regression: 3e1f015c0. The register and the caller's count of bytes
    were copied into a 257-byte stack buffer unchecked: 300 bytes overran
    it (an ASan stack-buffer-overflow) and a negative count was a memcpy
    of nearly the whole address space.
    """
    install(fppd, features=["NATIVE_I2C"])
    bus = Bus(fppd, [CHIP])
    bus.start(fppd)
    assert raw(fppd, 256) == "257", "256 bytes and the register"
    writes = bus.writes(CHIP)
    # (the bus logs a write's first 64 bytes)
    assert [(reg, data) for _, _, reg, data in writes] == [(0x06, b"\x5a" * 64)], writes
    for count in (300, -1):
        assert raw(fppd, count, reg=0x10) == "-1", count
        fppd.check_alive()
    assert len(bus.writes(CHIP)) == 1, bus.writes(CHIP)[1:]
