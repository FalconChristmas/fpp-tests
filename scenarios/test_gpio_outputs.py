"""GPIO outputs driven from several places at once: the GPIO channel output
on the frame path, and POST /api/gpio and the GPIO command from HTTP
threads.

They use the TmpFile pins a container build has (TF-1...), so they run in
Docker; on a device, where the board's pins replace them, they skip. Races
show under TSan (run.sh --flavor tsan): a TSan report fails the scenario.
"""

import os
import threading
import time

import pytest

import shims


def tmpfile_pins(fppd, n):
    pins = [p.get("pin") for p in fppd.get("/gpio") or []]
    want = [f"TF-{i}" for i in range(1, n + 1)]
    if not set(want) <= set(pins):
        pytest.skip("no TmpFile pins (TF-1...) in this build: a device build has the board's")
    return want


def test_pins_set_from_several_clients_at_once(fppd):
    """Four clients each setting their own pin through POST /api/gpio,
    toggling it with the GPIO command's Opposite and reading it back with
    GET /api/gpio, all at once and over and over: no data race (TSan), and
    each pin ends at the value last set.

    Regression: ff805681e. The last value each pin was set to is a std::map
    that every one of those wrote or read without a lock, so two clients
    setting two relays at once could corrupt it.
    """
    fppd.start()
    pins = tmpfile_pins(fppd, 4)
    errors = []

    def drive(pin):
        try:
            for i in range(60):
                fppd.post(f"/gpio/{pin}", {"value": i & 1})
                fppd.command("GPIO", pin, "Opposite")
                fppd.get(f"/gpio/{pin}")
            fppd.post(f"/gpio/{pin}", {"value": 1})
        except Exception as e:  # noqa: BLE001 -- reported below
            errors.append(f"{pin}: {e!r}")

    threads = [threading.Thread(target=drive, args=(p,)) for p in pins]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    fppd.check_alive()
    assert not errors, errors
    for pin in pins:
        assert fppd.get(f"/gpio/{pin}").get("value") == 1, pin


def test_a_gpio_output_error_warning_comes_down_when_the_pin_works(fppd):
    """A GPIO channel output whose pin throws on every write raises one
    "Exception in GPIO output" warning; once the pin works again the
    warning comes down by itself, within the 30 s it is raised for.

    The pin is made to throw by gpiothrow.cpp, which stands in for the
    pin's setValue() while a flag file exists.

    Regression: 0b7e59901. SendData() meant to raise the warning only when
    its message changed, but never remembered the message: the warning was
    re-added on every frame, raised with no timeout, and stayed up until
    fppd restarted.
    """
    flag = os.path.join(fppd.media, "tmp", "gpio-throws")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GPIO", "enabled": 1, "startChannel": 1, "channelCount": 1, "pin": "TF-3"}]})
    fppd.start(preload=[shims.build("gpiothrow.cpp")], extra_env={"GPIOTHROW_FLAG": flag})
    tmpfile_pins(fppd, 3)
    fppd.command("Test Start", "50", "RGB Cycle", "1-1", "R-G-B")
    # Init() sets the pin too: it fails from here on, once the output runs
    fppd.write("tmp/gpio-throws", "")

    def raised():
        return [w for w in fppd.get("/fppd/warnings") if "Exception in GPIO output" in str(w)]

    fppd.wait_for(raised, timeout=10, what="the GPIO output's warning")
    assert len(raised()) == 1, raised()
    os.unlink(flag)
    gone = time.monotonic()
    try:
        fppd.wait_for(lambda: not raised(), timeout=45, interval=1, what="the warning to come down")
    except TimeoutError:
        pytest.fail(f"the pin has worked for {time.monotonic() - gone:.0f} s and the warning "
                    f"is still up: {raised()}")
    fppd.check_alive()
