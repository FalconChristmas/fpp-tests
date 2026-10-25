"""The PCA9685 output's servo ports on a fake I2C bus (fakei2c.c, i2cbus.py):
the pulse each port's OFF count gives the chip, for the Servo Position
command and for a port of the Servos tab (co-pwm.json) in each data type.

Runs in Docker and under run-local.sh on a device (the bus answers for any
/dev/i2c-N). A co-pwm.json output reads its board from the cape's PWM
config, which comes out of a signed cape EEPROM; fakepwmcape.cpp hands it
one from the media directory instead.
"""

import math
import os

import shims
from i2cbus import Bus
from test_i2c_outputs import PCA, other_output, pca9685, servo_value, single

CLOCK = 25000000


def ticks(us, hz=50):
    """A pulse of `us` microseconds as the chip's 4096-step count, at the
    frequency the prescaler fppd picks for `hz` really gives."""
    prescale = int(CLOCK / 4096 / hz + 0.5)
    actual = CLOCK / (prescale * 4096)
    return us * actual * 4096 / 1000000


def rnd(x):
    """std::round: halves away from zero."""
    return int(math.floor(x + 0.5))


def test_servo_position_moves_the_port_to_its_percentage(fppd):
    """Servo Position <port> <percent> moves a servo port of a co-other
    PCA9685 to that point of its range, min to center for 0-50% and center
    to max above: OFF counts for 0%, 25% and 100% of 1000-1500-2000 us at
    50 Hz.

    Regression: 92ed8537b (the command added). Its parent has no Servo
    Position command.
    """
    bus = Bus(fppd, [PCA])
    fppd.write("config/co-other.json", other_output(pca9685()))
    fppd.settings(DisableFakeNetworkBridges="1")
    bus.start(fppd)
    lo, mid, hi = rnd(ticks(1000)), rnd(ticks(1500)), rnd(ticks(2000))
    for percent, want in ((100, hi), (0, lo), (25, rnd(lo + (mid - lo) * 0.5))):
        fppd.command("Servo Position", "1", str(percent))
        fppd.wait_for(lambda: servo_value(bus, PCA, 0) == want, timeout=5,
                      what=f"port 1 at {percent}% ({want}; it is at {servo_value(bus, PCA, 0)})")


def test_a_2x_absolute_servo_port_takes_two_steps_a_microsecond(fppd):
    """A Servos-tab (co-pwm.json) port in the "2x Absolute" data type, 8
    bit, reads its channel as two steps a microsecond past the port's
    minimum: channel value 200 is the minimum pulse plus 100 us. A plain
    "Absolute" port beside it reads one step as 2 us (40 is min + 80 us).

    Regression: b1a2c81b4. readValue() meant to turn 2x Absolute into
    Absolute once it had halved the value, but wrote `dt == ABSOLUTE`
    (a comparison) for `dt = ABSOLUTE`: the port matched no data type, so
    the raw channel value went to the chip as an OFF count and was clamped
    to the minimum pulse.
    """
    bus = Bus(fppd, [PCA])
    capes = os.path.join(fppd.media, "fakecape")
    fppd.write("fakecape/TestServos.json", {"driver": "PCA9685", "name": "TestServos",
                                            "address": PCA, "bus": "i2c-1"})
    port = {"type": "Servo", "min": 1000, "max": 2000, "is16bit": 0, "reverse": 0, "zero": "Hold"}
    fppd.write("config/co-pwm.json", {"channelOutputs": [{
        "type": "PCA9685", "subType": "TestServos", "enabled": 1, "startChannel": 0,
        "channelCount": -1, "frequency": "50hz",
        "outputs": [dict(port, startChannel=0, dataType="2x Absolute", description="a"),
                    dict(port, startChannel=1, dataType="Absolute", description="b")]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start(preload=[shims.build("fakei2c.c"), shims.build("fakepwmcape.cpp", libs=(
        "-ldl", "-I/usr/include/jsoncpp", "-ljsoncpp"))],
        extra_env=dict(bus.env, FAKEPWMCAPE_DIR=capes))
    single(fppd, "1-3", "#C82800")  # channel 1 = 200, channel 2 = 40
    lo = ticks(1000)
    want = (rnd(rnd(100 * ticks(1)) + rnd(lo)), rnd(rnd(80 * ticks(1)) + rnd(lo)))
    got = lambda: (servo_value(bus, PCA, 0), servo_value(bus, PCA, 1))
    try:
        fppd.wait_for(lambda: got() == want, timeout=5, what="both ports' pulses")
    except TimeoutError:
        raise AssertionError(f"OFF counts {got()}, wanted {want} (the minimum is {rnd(lo)})")
    fppd.command("Test Stop")
