"""The I2C channel outputs (PCA9685, MCP23017, PCF8574) on a fake I2C bus
(fakei2c.c, i2cbus.py): what they write to the chips.

The bus answers for /dev/i2c-N whether or not the machine has one, so these
run in Docker as well as under run-local.sh on a device (where every
/dev/i2c-N is /dev/null and the fake answers instead of the cape's chips).
"""

import os
import time
import urllib.error

import pytest

from i2cbus import Bus

PCA = 0x40
MCP = 0x20
PCF = 0x21


def other_output(o):
    return {"channelOutputs": [o]}


def pca9685(ports=2, start=1):
    return {"type": "PCA9685", "enabled": 1, "startChannel": start,
            "channelCount": ports * 2, "device": "i2c-1", "deviceID": PCA,
            "frequency": 50, "asUsec": 1,
            "ports": [{"description": f"servo{x + 1}", "min": 1000, "center": 1500, "max": 2000,
                       "dataType": 0, "zeroBehavior": 0} for x in range(ports)]}


def single(fppd, channels, color="#FF0000"):
    """Light just `channels` ("41-41"), through the channel tester."""
    fppd.command("Test Start", "1000", "RGB Single Color", channels, color)


def mode1_writes(bus):
    return [d[0] for _, _, reg, d in bus.writes(PCA) if reg == 0x00]


def test_a_pca9685_whose_mode1_read_fails_never_turns_on_its_external_clock(fppd):
    """When reading MODE1 fails, the PCA9685 output still never writes
    MODE1 with EXTCLK (bit 6) set -- it has no external clock configured,
    and the chip only clears that bit on a power cycle.

    Regression: d641c3d6a. Init, StartingOutput and StoppingOutput updated
    MODE1 read-modify-write; a failed read is -1, which as a register value
    has every bit set, so one bus error at startup wrote 0x7F (sleep +
    EXTCLK) and left the board with its oscillator off until it was
    unplugged.
    """
    bus = Bus(fppd, [PCA], fail=[(PCA, 0x00)])
    fppd.write("config/co-other.json", other_output(pca9685()))
    fppd.settings(DisableFakeNetworkBridges="1")
    bus.start(fppd)
    single(fppd, "1-4")
    fppd.wait_for(lambda: any(r == 0x06 for _, _, r, _ in bus.writes(PCA)), what="a frame sent")
    fppd.command("Test Stop")
    m = mode1_writes(bus)
    assert m, bus.writes(PCA)
    assert not [v for v in m if v & 0x40], f"MODE1 written with EXTCLK: {[hex(v) for v in m]}"


def test_a_pca9685_with_more_ports_than_the_chip_writes_only_its_16(fppd):
    """A PCA9685 config with 20 ports (the chip has 16) sends frames to
    LED0..LED15 only, never on into the registers past LED15_OFF_H (0x45).

    Regression: d641c3d6a. The port count came from the JSON: 20 ports
    indexed past the 16-entry port array and the 32-entry data array, and
    each frame went out as 80 bytes from LED0, over the chip's reserved
    registers.

    Also d5806e148: d641c3d6a's FPPD_MAX_CHANNELS reached PCA9685.cpp only
    through the precompiled header, so without it (--nopch, distributed
    builds) the output didn't build.
    """
    bus = Bus(fppd, [PCA])
    fppd.write("config/co-other.json", other_output(pca9685(ports=20)))
    fppd.settings(DisableFakeNetworkBridges="1")
    bus.start(fppd)
    single(fppd, "1-40")
    fppd.wait_for(lambda: any(r == 0x06 for _, _, r, _ in bus.writes(PCA)), what="a frame sent")
    fppd.command("Test Stop")
    frames = [(r, d) for _, _, r, d in bus.writes(PCA) if r == 0x06]
    past = [len(d) for r, d in frames if r + len(d) - 1 > 0x45]
    assert not past, f"frames of {sorted(set(past))} bytes from LED0 run past LED15"


def test_a_16_port_pca9685_frame_reaches_all_16_ports(fppd):
    """A PCA9685 with all 16 ports gets each frame as one 64-byte write from
    LED0, so ports 9 to 16 get their pulse too.

    Regression: 152adce7f. Frames went out through the SMBus block write,
    which carries at most 32 bytes: ports 9 to 16 were never written."""
    bus = Bus(fppd, [PCA])
    fppd.write("config/co-other.json", other_output(pca9685(ports=16)))
    fppd.settings(DisableFakeNetworkBridges="1")
    bus.start(fppd)
    single(fppd, "1-32")
    fppd.wait_for(lambda: any(r == 0x06 for _, _, r, _ in bus.writes(PCA)), what="a frame sent")
    fppd.command("Test Stop")
    sizes = sorted({len(d) for _, _, r, d in bus.writes(PCA) if r == 0x06})
    assert sizes == [64], f"frames from LED0 of {sizes} bytes"
    assert servo_value(bus, PCA, 15) > 0, "port 16 never got a pulse"


def servo_value(bus, addr, port):
    """Port's (0-based) OFF count as the chip at addr last got it."""
    regs = bus.registers(addr)
    base = 0x06 + 4 * port
    return regs.get(base + 2, 0) | (regs.get(base + 3, 0) << 8)


def test_servo_position_outlives_the_other_pca9685(fppd):
    """With two PCA9685 boards, each registers Servo Position and the
    later one (in channeloutputs.json, read after co-other.json) holds it.
    Disabling the other board leaves Servo Position working on this one.

    Regression: 730bd227c. An output's destructor removed the command by
    name, so taking away the board whose registration had been replaced
    unregistered the one that was still there, until fppd restarted.
    """
    PCA2 = PCA + 1
    bus = Bus(fppd, [PCA, PCA2])
    second = dict(pca9685(start=5), deviceID=PCA2)
    fppd.write("config/co-other.json", other_output(pca9685()))
    fppd.write("config/channeloutputs.json", other_output(second))
    fppd.settings(DisableFakeNetworkBridges="1")
    bus.start(fppd)

    def move(position, was):
        fppd.command("Servo Position", "1", str(position))
        return fppd.wait_for(lambda: servo_value(bus, PCA2, 0) != was and servo_value(bus, PCA2, 0),
                             what=f"servo 1 on the second board at {position}%")

    full = move(100, servo_value(bus, PCA2, 0))
    zero = move(0, full)
    assert full > zero, (full, zero)

    # Disable the first board, as unticking it on the Other outputs page
    # and saving does; its output is stopped (MODE1 sleep) and deleted.
    writes = len(mode1_writes(bus))
    tmp = fppd.write("config/co-other.json.new", other_output(dict(pca9685(), enabled=0)))
    os.replace(tmp, os.path.join(fppd.media, "config", "co-other.json"))
    fppd.wait_for(lambda: len(mode1_writes(bus)) > writes, timeout=15,
                  what="the first board's output to stop")
    time.sleep(1)
    names = [c.get("name") for c in fppd.get("/commands")]
    assert "Servo Position" in names, "Servo Position is gone with the second board still there"
    try:
        assert move(100, zero) == full
    except urllib.error.HTTPError as e:
        pytest.fail(f"Servo Position failed: {e.code} {e.body}")


def test_an_mcp23017_with_more_channels_than_pins_drives_only_its_16(fppd):
    """An MCP23017 configured for 48 channels drives its 16 pins from the
    first 16; channel 41 lights no pin.

    Regression: 5714a8b21. SendData shifted a bit per channel with no
    limit: past 40 channels the shift count passed an int's width, and the
    count wraps (mod 32 on both ARM and x86), so channel 41 set GPIOB bit
    0 -- channel 9's pin.
    """
    bus = Bus(fppd, [MCP])
    fppd.write("config/co-other.json", other_output(
        {"type": "MCP23017", "enabled": 1, "startChannel": 1, "channelCount": 48,
         "deviceID": MCP}))
    fppd.settings(DisableFakeNetworkBridges="1")
    bus.start(fppd)
    gpio = lambda: (bus.registers(MCP).get(0x12), bus.registers(MCP).get(0x13))
    # the control: channel 9 is GPIOB pin 0
    single(fppd, "9-9")
    fppd.wait_for(lambda: gpio() == (0, 1), what="channel 9 on GPIOB pin 0")
    single(fppd, "41-41")
    time.sleep(1)
    assert gpio() == (0, 0), f"channel 41 alone set GPIOA/GPIOB to {gpio()}"
    fppd.command("Test Stop")


def test_a_pcf8574_with_more_channels_than_pins_drives_only_its_8(fppd):
    """A PCF8574 configured for 16 channels drives its 8 pins from the first
    8 (pin 7 is channel 1 in the default pin order).

    Regression: 2c55c695d. SendData indexed the 8-entry port array by
    channel: 16 channels read past it on every frame and could write a
    byte past the object. The pins came out right all the same, so it is
    the ASan build that goes red here (a heap-buffer-overflow).
    """
    bus = Bus(fppd, [PCF])
    fppd.write("config/co-other.json", other_output(
        {"type": "PCF8574", "enabled": 1, "startChannel": 1, "channelCount": 16,
         "device": "i2c-1", "deviceID": PCF, "pinOrderingInvert": 0, "relayNumbering": 0}))
    fppd.settings(DisableFakeNetworkBridges="1")
    bus.start(fppd)
    latched = lambda: bus.registers(PCF).get(None)
    single(fppd, "1-1")
    fppd.wait_for(lambda: latched() == 0x80, what="channel 1 on pin 7")
    single(fppd, "9-16")
    fppd.wait_for(lambda: latched() == 0x00, what="channels 9-16 lighting no pin")
    fppd.command("Test Stop")
