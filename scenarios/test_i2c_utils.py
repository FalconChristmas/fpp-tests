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


PCF = 0x21


def test_a_chip_that_answers_no_read_can_still_be_written_when_asked_to_skip_the_probe(fppd):
    """A plugin that opens a chip with I2CUtils(bus, addr, true) -- a chip
    that NAKs a plain byte read until it has been set up -- gets a usable
    handle: its block write reaches the chip.

    Regression: e5470bb52. Since e3b2c09e5 every I2CUtils read a byte to see
    the chip was there and closed the handle when the read failed, so such
    a chip could never be opened, let alone set up; the third argument
    skips that read.
    """
    install(fppd, features=["NATIVE_I2C"])
    bus = Bus(fppd, [CHIP], noprobe=[CHIP])
    bus.start(fppd)
    assert raw(fppd, 4) == "5", "the register and 4 bytes"
    assert [(reg, data) for _, _, reg, data in bus.writes(CHIP)] == [(0x06, b"\x5a" * 4)], bus.writes(CHIP)


def test_an_output_whose_chip_is_not_on_the_bus_says_so_and_writes_nothing(fppd):
    """A PCF8574 output configured at an address where no chip answers
    fails to open its device and says so in fppd's log, rather than
    starting and writing every frame into nothing; the same output at
    the address the chip is at opens it.

    Regression: e3b2c09e5. I2CUtils only opened /dev/i2c-N and set the
    slave address, which succeed whatever is on the bus, so a missing or
    misaddressed chip looked like a working output.
    """
    bus = Bus(fppd, [PCF])
    fppd.write("config/co-other.json", {"channelOutputs": [
        {"type": "PCF8574", "enabled": 1, "startChannel": 1, "channelCount": 8,
         "device": "i2c-1", "deviceID": 0x22, "pinOrderingInvert": 0, "relayNumbering": 0},
        {"type": "PCF8574", "enabled": 1, "startChannel": 9, "channelCount": 8,
         "device": "i2c-1", "deviceID": PCF, "pinOrderingInvert": 0, "relayNumbering": 0}]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="debug")
    bus.start(fppd)
    fppd.wait_for(lambda: "PCF8574Output opened I2C device ok" in fppd.log(), what="the output at 0x21 opened")
    log = fppd.log()
    assert log.count("Error opening I2C device for PCF8574 output") == 1, fppd.tail(60)
    assert log.count("PCF8574Output opened I2C device ok") == 1, fppd.tail(60)
