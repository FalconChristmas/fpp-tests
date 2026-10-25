"""The uDMX USB DMX output (UDMX.cpp), on dongles that are not there.

No uDMX dongle is to hand, so fakeudmx.c stands in for libusb under fppd:
the output enumerates, opens and drives fake 16c0:05dc dongles at the bus
and port a scenario gives them, and every open, serial read and control
transfer -- the transfer is the DMX universe on its way to the dongle --
is logged for the scenario to read back. The kernel's cached serial, which
the output reads from /sys/bus/usb/devices/<bus>-<port>/serial, is a
tmpfs over that directory for the run.

Runs in Docker or on a device (run-local.sh); the serial-path scenarios
need a /sys/bus/usb/devices to mount over.
"""

import contextlib
import os
import subprocess

import pytest

import shims
from test_output_warnings import wait_for_warnings


def udmx(channels, device=None):
    out = {"type": "UDMX", "enabled": 1, "startChannel": 1, "channelCount": channels}
    if device is not None:
        out["device"] = device
    return {"channelOutputs": [out]}


def start(fppd, dongles, config):
    """fppd with `dongles` ({"BUS-PORT": serial}) plugged in and the output
    configured; returns the fake's log path."""
    log = os.path.join(fppd.media, "tmp", "udmx.log")
    fppd.write("config/co-other.json", config)
    fppd.settings(DisableScheduler="1")
    fppd.start(preload=[shims.build("fakeudmx.c", libs=("-lpthread",))], extra_env={
        "FAKE_UDMX": ",".join(f"{p}={s}" for p, s in dongles.items()), "FAKE_UDMX_LOG": log})
    return log


def calls(log):
    try:
        with open(log) as f:
            return [l.split() for l in f.read().splitlines()]
    except FileNotFoundError:
        return []


def xfers(log, path=None):
    """(value, index, length, data) of each logged control transfer."""
    return [(int(c[2]), int(c[3]), int(c[4]), bytes.fromhex(c[5]) if len(c) > 5 else b"")
            for c in calls(log) if c[0] == "xfer" and (path is None or c[1] == path)]


def hold(fppd, first, last, value):
    """Hold channels first..last (1-based) at value with an overlay range."""
    fppd.request("PUT", f"/overlays/range/{first}-{last}", {"Value": value})


@contextlib.contextmanager
def sysfs_serials(serials):
    """/sys/bus/usb/devices as a tmpfs holding `serials` ({"BUS-PORT": serial})."""
    d = "/sys/bus/usb/devices"
    if not os.path.isdir(d):
        pytest.skip(f"no {d} to mount over")
    r = subprocess.run(["mount", "-t", "tmpfs", "tmpfs", d], capture_output=True, text=True)
    if r.returncode:
        pytest.skip(f"cannot mount over {d}: {r.stderr.strip()}")
    try:
        for path, serial in serials.items():
            os.makedirs(os.path.join(d, path))
            with open(os.path.join(d, path, "serial"), "w") as f:
                f.write(serial + "\n")
        yield
    finally:
        subprocess.run(["umount", d])


def test_the_dmx_values_reach_the_dongle_from_channel_one(fppd):
    """Channels 1-4 held at 42: the transfer to the dongle sets exactly the
    output's 16 channels, the first four of them 42.

    Regression: de6de0c8d. The transfer carried the start-code byte in
    front of the values and one channel more than configured, so every
    fixture was a channel off."""
    log = start(fppd, {"9-7": "AAA"}, udmx(16))
    hold(fppd, 1, 4, 42)
    want = bytes([42] * 4) + bytes(12)
    fppd.wait_for(lambda: any(42 in x[3] for x in xfers(log)), timeout=10,
                  what="the held values in a transfer")
    last = xfers(log)[-1]
    assert last == (16, 0, 16, want), last


def test_more_than_a_universe_is_clamped_and_keeps_sending(fppd):
    """A uDMX output configured with 600 channels is cut to the 512 a DMX
    universe holds, with the config warning (28) up, and keeps sending
    full universes to the dongle, the held values in them.

    Regression: 5a5c3ff34. The count was never bounded: 600 channels were
    copied into the 513-byte packet buffer, over the libusb handle behind
    it, and the next USB call went through channel data -- here, the
    copied zeros nulled the handle and nothing reached the dongle again."""
    log = start(fppd, {"9-7": "AAA"}, udmx(600))
    hold(fppd, 1, 8, 0x55)
    fppd.wait_for(lambda: any(x[3][:8] == bytes([0x55] * 8) for x in xfers(log)),
                  timeout=10, what="the held values in a transfer")
    assert fppd.proc.poll() is None, f"fppd died\n{fppd.tail()}"
    assert not [c for c in calls(log) if c[0] == "badhandle"], calls(log)[-5:]
    assert {x[:3] for x in xfers(log)} == {(512, 0, 512)}, sorted({x[:3] for x in xfers(log)})
    wait_for_warnings(fppd, [(28, "exceeds the DMX universe size of 512")])


@pytest.mark.parametrize("by", ["path", "serial"])
def test_the_configured_dongle_is_the_one_driven(fppd, by):
    """Two dongles plugged in, and the output configured with the second's
    USB path (bus-port) or its serial: that one is opened and gets the
    DMX, not the first one found.

    Regression: 9619ce545. The first uDMX enumerated was always taken, so
    a box with two could not say which universe went where."""
    with sysfs_serials({"9-7": "AAA", "9-8": "BBB"}):
        log = start(fppd, {"9-7": "AAA", "9-8": "BBB"}, udmx(8, "9-8" if by == "path" else "BBB"))
        hold(fppd, 1, 1, 7)
        fppd.wait_for(lambda: any(x[3][:1] == b"\x07" for x in xfers(log, "9-8")), timeout=10,
                      what="the held value in a transfer to 9-8")
        assert [c for c in calls(log) if c[0] == "open"] == [["open", "9-8"]], calls(log)[:10]
        assert not xfers(log, "9-7"), xfers(log, "9-7")[:3]


def test_a_dongle_is_found_by_its_sysfs_serial_without_opening_it(fppd):
    """Configured by serial, with the kernel's cached serials in sysfs: the
    output finds its dongle from sysfs and opens only that one, once, to
    drive it -- no dongle is opened to have its serial descriptor read.

    Regression: 6347b381e. Every candidate was opened to read its serial
    descriptor, which a uDMX's firmware USB stack does not always answer;
    a dongle that missed one was taken for not the configured one."""
    with sysfs_serials({"9-7": "AAA", "9-8": "BBB"}):
        log = start(fppd, {"9-7": "AAA", "9-8": "BBB"}, udmx(8, "BBB"))
        hold(fppd, 1, 1, 9)
        fppd.wait_for(lambda: any(x[3][:1] == b"\x09" for x in xfers(log, "9-8")), timeout=10,
                      what="the held value in a transfer to 9-8")
        assert not [c for c in calls(log) if c[0] == "serial"], calls(log)[:10]
        assert [c for c in calls(log) if c[0] == "open"] == [["open", "9-8"]], calls(log)[:10]
