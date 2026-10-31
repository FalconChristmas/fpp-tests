"""GPIO channel outputs in PWM mode on a Raspberry Pi 5's header (P1-12,
P1-32, P1-33; P1-13 has no PWM), on the real pads and the real RP1 PWM
chip, across output reloads.

Device only: run with run-local.sh on a Raspberry Pi 5 (PiGPIOUtils is built
only for a Pi, and only the Pi 5 has its PWM chip without an overlay).
run-local.sh gives fppd a read-only /sys and a pinctrl stub; here the RP1
PWM chip's sysfs directory is made writable and the real pinctrl put back
for fppd, for this scenario only, so fppd exports a PWM channel and muxes
the pad for real. The pad is put back as it was afterwards, and any PWM
channel fppd exported is unexported. Skipped where GPIO18 or its PWM
channels are in use.

The receiving end is the pad's function as the real pinctrl reads it from
RP1 (PWM0_CHAN2 when muxed for PWM, "none" at its reset mode) and the
kernel's PWM channel state; the pad's level can't be read while a
peripheral drives it.
"""

import glob
import os
import re
import subprocess
import time

import pytest

import hosttools

GPIO = 18
PIN = "P1-12"
PWMCHIP = "/sys/class/pwm/pwmchip0"


def on_pi5():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith(("Raspberry Pi 5", "Raspberry Pi Compute Module 5"))
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not on_pi5() or not os.path.isdir(PWMCHIP),
                                reason="a Raspberry Pi 5 with its RP1 PWM chip")


def pad_function(gpio=GPIO):
    """The pad's function name as the real pinctrl reports it
    ("PWM0_CHAN2", "none", "input")."""
    r = subprocess.run([hosttools.real("pinctrl"), "get", str(gpio)], capture_output=True, text=True)
    return r.stdout.split("=", 1)[-1].strip()


def exported():
    return {int(m.group(1)) for p in os.listdir(PWMCHIP) if (m := re.fullmatch(r"pwm(\d+)", p))}


@pytest.fixture
def pads():
    with hosttools.pads_kept([GPIO, 12, 13, 27]):
        yield


@pytest.fixture
def pwm_chip():
    """The RP1 PWM chip's sysfs directory writable for fppd; channels fppd
    exports are unexported after it has stopped."""
    before = exported()
    if before:
        pytest.skip(f"PWM channels {sorted(before)} are already exported here")
    d = os.path.realpath(PWMCHIP)
    r = subprocess.run(f"mount --bind {d} {d} && mount -o remount,bind,rw {d}",
                       shell=True, capture_output=True, text=True)
    if r.returncode:
        pytest.skip("cannot make the PWM chip writable here: " + r.stderr.strip())
    try:
        yield d
    finally:
        for ch in exported() - before:
            try:
                with open(os.path.join(d, f"pwm{ch}", "enable"), "w") as f:
                    f.write("0")
            except OSError:
                pass
            with open(os.path.join(d, "unexport"), "w") as f:
                f.write(str(ch))
        subprocess.run(["umount", d])


@pytest.fixture
def real_pinctrl():
    """fppd's pinctrl is the real one for this scenario (run-local.sh's stub
    is bound over it; the real one goes over the stub, and comes off
    after)."""
    real = hosttools.real("pinctrl")
    if not hosttools.stubbed("pinctrl"):
        yield
        return
    target = os.path.realpath(subprocess.run(["sh", "-c", "command -v pinctrl"],
                                             capture_output=True, text=True).stdout.strip())
    subprocess.run(["mount", "--bind", real, target], check=True)
    try:
        yield
    finally:
        subprocess.run(["umount", target])


def gpio_is_free(gpio=GPIO):
    if hosttools.pad_states([gpio])[gpio] is None:
        pytest.skip(f"pinctrl can't read GPIO{gpio} here")
    r = subprocess.run(["gpioinfo"], capture_output=True, text=True)
    line = next((l for l in r.stdout.splitlines() if f'"GPIO{gpio}"' in l), "")
    if "consumer=" in line or "[used]" in line:
        pytest.skip(f"GPIO{gpio} is in use here: {line.strip()}")
    if pad_function(gpio) not in ("none", "input"):
        pytest.skip(f"GPIO{gpio} is muxed to {pad_function(gpio)} here")


def pwm_output(start=1, pin=PIN):
    return {"channelOutputs": [{"enabled": 1, "type": "GPIO", "startChannel": start,
                                "channelCount": 1, "pin": pin, "pwm": 1, "invert": 0}]}


def reloads(fppd):
    return sum(1 for line in fppd.log().splitlines()
               if "Reloading Channel Outputs for " in line and line.rstrip().endswith("/co-other.json"))


def reload_outputs(fppd, start):
    """Save co-other.json again (a different start channel, so it is a
    real change) and wait for fppd to have reloaded the outputs from it."""
    base = reloads(fppd)
    fppd.write("config/co-other.json", pwm_output(start))
    fppd.wait_for(lambda: reloads(fppd) > base, timeout=10, what="the outputs to reload")
    time.sleep(1)  # the new output's Init runs after the log line


def fppd_pid():
    pids = subprocess.run(["pgrep", "-x", "fppd"], capture_output=True, text=True).stdout.split()
    assert len(pids) == 1, pids
    return int(pids[0])


def open_duty_files():
    """The PWM duty_cycle files fppd holds open."""
    fds = glob.glob(f"/proc/{fppd_pid()}/fd/*")
    out = []
    for fd in fds:
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if re.search(r"/pwm\d+/duty_cycle$", target):
            out.append(target)
    return out


def start_pwm_output(fppd, pin=PIN, gpio=GPIO, function="PWM0_CHAN2"):
    gpio_is_free(gpio)
    fppd.write("config/co-other.json", pwm_output(pin=pin))
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.start()
    fppd.wait_for(lambda: reloads(fppd) >= 1, timeout=10, what="the startup load of co-other.json")
    fppd.wait_for(lambda: pad_function(gpio) == function, timeout=10,
                  what=f"fppd to mux GPIO{gpio} to {function} (it is {pad_function(gpio)})")


def test_a_pwm_output_keeps_its_pad_across_output_reloads(pads, pwm_chip, real_pinctrl, fppd):
    """A GPIO output in PWM mode on P1-12: fppd muxes GPIO18 to its PWM
    function (PWM0_CHAN2) at startup, and it is still muxed for PWM after
    each of three saves of co-other.json reloads the outputs.

    Regression: 96ea7df35. Since adba066ac setupPWM() returned early once
    its duty_cycle file was open, without muxing the pin; the old output's
    releasePin() had put the pad back to its reset mode ("none") on the
    reload, so the new output's PWM reached no pin until fppd restarted.
    """
    start_pwm_output(fppd)
    for i in range(3):
        reload_outputs(fppd, 2 + i)
        assert pad_function() == "PWM0_CHAN2", \
            f"reload {i + 1}: GPIO18 is {pad_function()}, not muxed for PWM\n{fppd.tail()}"


def test_output_reloads_leave_one_open_duty_file(pads, pwm_chip, real_pinctrl, fppd):
    """A GPIO output in PWM mode on P1-12, reloaded by three saves of
    co-other.json: fppd holds one open PWM duty_cycle file throughout, the
    one it opened at startup.

    Regression: adba066ac (UT-12, its leak half). setupPWM() opened a new
    duty_cycle stream on every call and dropped the old one without closing
    it, so each output reload leaked a file descriptor.

    adba066ac's other half (the libgpiod v2 chip lookup asked for
    "pinctrl-rpi1" where the Pi 5's chip is "pinctrl-rp1") is not shown
    here: the lookup's fallback, the first 54-line chip, is the same chip
    on a Pi 5, whose only 54-line chip is pinctrl-rp1.
    """
    start_pwm_output(fppd)
    first = open_duty_files()
    assert len(first) == 1, first
    for i in range(3):
        reload_outputs(fppd, 2 + i)
    assert open_duty_files() == first, open_duty_files()


# GPIO19 (P1-35, PWM0_CHAN3) is left out: a Pi 5's fan holds channel 3.
@pytest.mark.parametrize("pin,gpio,function", [("P1-12", 18, "PWM0_CHAN2"),
                                               ("P1-32", 12, "PWM0_CHAN0"),
                                               ("P1-33", 13, "PWM0_CHAN1")],
                         ids=["P1-12", "P1-32", "P1-33"])
def test_the_pwm_channel_fppd_drives_is_the_one_on_the_pad(pads, pwm_chip, real_pinctrl, fppd,
                                                           pin, gpio, function):
    """A GPIO output in PWM mode on each PWM header pin a Pi 5 has free,
    test mode lighting its channel full: fppd muxes the pad to its PWM
    function, and the one PWM channel it exports and writes the duty to
    is that function's channel, at the full-on duty (25500 ns).

    Regression: d2061bc52. PiGPIOUtils muxed every PWM pin to alt3 and
    numbered the channels as on a BCM2711: P1-12 got channel 0 though its
    RP1 alt3 is PWM0_CHAN2, so the duty reached no pin; P1-32's alt3 is
    no PWM function at all (its PWM is alt0), and P1-33 wasn't offered as
    PWM. Found while testing 96ea7df35 and adba066ac.

    Also ce2e621f3, which first gave a Pi 5's PWM pins their alt function
    and the sysfs channel export/duty path: without the mux the pad stays
    "none", without the export there is no channel to write the duty to.
    """
    start_pwm_output(fppd, pin, gpio, function)
    channel = int(function.rsplit("CHAN", 1)[1])
    fppd.command("Test Start", 1000, "RGB Single Color", "1-1", "#FFFFFF")
    try:
        duty = os.path.join(PWMCHIP, f"pwm{channel}", "duty_cycle")
        fppd.wait_for(lambda: os.path.exists(duty) and open(duty).read().strip() == "25500",
                      timeout=5, what=f"the full-on duty on channel {channel}")
        assert exported() == {channel}, f"fppd exported PWM channels {sorted(exported())}"
        with open(os.path.join(PWMCHIP, f"pwm{channel}", "enable")) as f:
            assert f.read().strip() == "1"
    finally:
        fppd.command("Test Stop")


def test_a_pin_with_no_pwm_function_is_refused_for_pwm(pads, pwm_chip, real_pinctrl, fppd):
    """A GPIO output in PWM mode on P1-13 (GPIO27, which has no PWM
    function on any Pi) is refused: no PWM channel is exported and the pad
    is left as it was.

    Regression: d2061bc52. P1-13 was offered as PWM channel 1, so fppd
    exported a channel and re-muxed GPIO27 to an alt function that is not
    PWM (on RP1, alt3 of GPIO27 is not a PWM channel).
    """
    gpio_is_free(27)
    before = pad_function(27)
    fppd.write("config/co-other.json", pwm_output(pin="P1-13"))
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.start()
    fppd.wait_for(lambda: reloads(fppd) >= 1, timeout=10, what="the startup load of co-other.json")
    time.sleep(1)
    # "does now support" until 7275fab38 fixed the typo
    assert re.search(r"does no[tw] support PWM", fppd.log()), fppd.tail()
    assert not exported(), f"PWM channels {sorted(exported())} exported for P1-13"
    assert pad_function(27) == before, pad_function(27)
