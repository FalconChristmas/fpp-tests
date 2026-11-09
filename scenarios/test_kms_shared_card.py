"""Two KMS framebuffer outputs on one display card.

On a Raspberry Pi 0-4, a DPI panel (DPIPixels' WS281x strings, or any output
on DPI-1) and the HDMI port are both on vc4's card0; a Pi 4's two HDMI ports
are too.  fppd opens each card once, so every output on it queues its page
flips, and reads every output's flip events, on one fd -- and all of them,
on every card, share fppd's drmMasterLock.

The first two run anywhere, Docker included: the display is the fake card of
fakedrm.c with a second head (FAKEDRM_SECOND, see fakedrm.py), each CRTC on
its own vblank grid.  The last needs the real hardware.

FPP #3171: a K8-Pi's DPIPixels at 20 Hz beside a Virtual Matrix on HDMI with
no display attached (which 10.3 started driving with a stand-in 1080p60) --
the props flickered and the sequence ran jerky and late.  Reproduced on a
Pi 3B+ at 668641b4a: 236 DPI and 204 HDMI flips refused in a minute, the
output thread's send taking 52-88 ms of its 50 ms frame.  Fixed in
4bea0042e.
"""

import glob
import os
import re
import time

import pytest

import fakedrm
import shims
from fppd import sanitizer

FLIP_PATH = re.compile(r"KMSFrameBuffer (\S+) flip-path event; totals since start: \d+ syncs >20ms "
                       r"\([^)]*\), (\d+) wait timeouts, (\d+) flip rejects")
SLOW = re.compile(r"SLOW Output Thread: Loop: \d+us, Send: (\d+)us")


def matrix(device, start, w=64, h=32):
    return {"enabled": 1, "type": "VirtualMatrix", "startChannel": start, "channelCount": w * h * 3,
            "device": device, "width": w, "height": h}


def totals(log):
    """{connector: (wait timeouts, flip rejects)} from the latest flip-path
    warning for each in `log`."""
    out = {}
    for m in FLIP_PATH.finditer(log):
        out[m.group(1)] = (int(m.group(2)), int(m.group(3)))
    return out


def start_dpi_and_hdmi(fppd, interval_ms, env_more=None, preload_more=()):
    """A Virtual Matrix on the fake card's 20 Hz DPI panel (channels 1-6144)
    and one on its 60 Hz HDMI display (6145-12288), fppd's frame interval
    `interval_ms`; up, with test mode stepping a colour every frame (the
    matrices flip only when their data changes, as a sequence's does)."""
    fppd.write("config/co-other.json", {"channelOutputs": [matrix("DPI-1", 1), matrix("HDMI-A-1", 6145)]})
    fppd.settings(DisableFakeNetworkBridges="1", E131BridgingInterval=str(interval_ms),
                  LogLevel_ChannelOut="info")
    preload, env = fakedrm.two_display_env(fppd, "DPI-1", "HDMI-A-1")
    env.update(env_more or {})
    fppd.start(preload=preload + list(preload_more), extra_env=env)
    for c in ("DPI-1", "HDMI-A-1"):
        fppd.wait_for(lambda c=c: f"KMSFrameBuffer: {c} mode" in fppd.log(), timeout=15,
                      what=f"the Virtual Matrix on the fake {c}")
    fppd.command("Test Start", interval_ms, "RGB Cycle", "1-12288", "R-G-B")


@pytest.mark.skipif(sanitizer() == "tsan", reason="a flip-rate test; TSan's fppd can't make 50 frames a second "
                    "(34 measured), and the lock test below covers this under TSan")
def test_an_hdmi_output_keeps_its_rate_beside_a_20hz_dpi_output(fppd):
    """Virtual Matrices on the 20 Hz DPI panel and the 60 Hz HDMI display of
    one card, fed 50 frames a second for 8 s: the HDMI one keeps up (over 35
    flips a second), not held to the DPI panel's 20.  (50, not 100: a Pi 3B+
    running this with run-local.sh can't make 100 test-mode frames a second.)

    Regression: 4bea0042e (#3171). SyncDisplay() held drmMasterLock -- one lock for every
    KMS output in fppd -- through the wait for its last flip and the
    phase-alignment sleep: at 20 Hz, most of a 50 ms frame.  The HDMI
    output's flips queued behind the DPI output's, one per DPI refresh
    (measured here: 20 a second before the fix, 50 after).  Two HDMI
    outputs alone flip at 60 either way.
    """
    start_dpi_and_hdmi(fppd, 20, env_more={"FAKEDRM_LOG_FLIPS": "1"})
    mark = len(fakedrm.log(fppd).splitlines())
    time.sleep(8)
    flips = fakedrm.log(fppd).splitlines()[mark:]
    fppd.command("Test Stop")
    hdmi = sum(1 for line in flips if line == "flip 131")
    dpi = sum(1 for line in flips if line == "flip 97")
    assert dpi >= 8 * 15, f"the DPI matrix flipped only {dpi} times in 8 s (precondition: about 20 a second)"
    assert hdmi >= 8 * 35, (f"the HDMI matrix flipped {hdmi} times in 8 s ({hdmi / 8:.0f} a second) beside "
                            f"the 20 Hz DPI one's {dpi}: held to the DPI panel's rate")
    assert not fakedrm.flip_refusals(fppd), fakedrm.flip_refusals(fppd)[:3]


def test_a_20hz_output_does_not_hold_the_drm_lock_through_its_waits(fppd):
    """The DPI and HDMI matrices of the first test fed at 20 fps, a sequence's
    rate: another thread taking drmMasterLock 500 times never waits as long
    as 15 ms for it, and seldom over 1 ms.

    Regression: 4bea0042e (#3171) (see the first test).  Every other output's flip, the
    output thread's WaitForPageFree() before it writes a DPI frame, and a
    video's DRM lease, waited out the 20 Hz output's sleeps -- measured
    here before the fix: 85-127 of 500 takes over 1 ms, the longest 30-38 ms;
    after it, none over 1 ms and the longest a few microseconds.

    lockwait.so does the timing from inside fppd, 6 s after it starts.
    """
    out = os.path.join(fppd.media, "tmp", "lockwait.txt")
    lockwait = shims.build("lockwait.c", libs=("-ldl", "-lpthread"))
    start_dpi_and_hdmi(fppd, 50, preload_more=[lockwait],
                       env_more={"LOCKWAIT_OUT": out, "LOCKWAIT_DELAY_MS": "6000",
                                 "LOCKWAIT_COUNT": "500", "LOCKWAIT_LOCK": "drmMasterLock"})

    def result():
        try:
            with open(out) as f:
                line = f.read()
        except FileNotFoundError:
            return None
        return line if line.endswith("\n") else None
    line = fppd.wait_for(result, timeout=40, what="lockwait's timings")
    fppd.command("Test Stop")
    assert line.strip() != "missing", "fppd has no drmMasterLock to time"
    samples, over, median, longest = (int(v) for v in line.split())
    # After the fix: none over 1 ms, the longest a few microseconds.  Either
    # test alone can miss a lock held for a sleep at a time (it is taken a
    # few ms apart); the longest wait rarely does.
    assert over <= 10 and longest < 15000, \
        (f"{over} of {samples} takes of drmMasterLock waited over 1 ms "
         f"(median {median} us, longest {longest / 1000:.1f} ms) while the matrices flipped")


def real_dpi_and_hdmi_on_one_card():
    """None, or why this device can't run the DPI + HDMI hardware test."""
    from test_dpi_pixels import on_pi
    if not on_pi():
        return "DPIPixels is built for a Raspberry Pi"
    dpi = glob.glob("/sys/class/drm/card*-DPI-1/status")
    hdmi = glob.glob("/sys/class/drm/card*-HDMI-A-1/status")
    if not dpi:
        return "no DPI-1 connector: config.txt doesn't load vc4-kms-dpi-fpp (a DPI cape's overlay)"
    if not hdmi:
        return "no HDMI-A-1 connector"
    if dpi[0].split("/")[4].split("-")[0] != hdmi[0].split("/")[4].split("-")[0]:
        return "DPI-1 and HDMI-A-1 are on different cards (a Pi 5's RP1 DPI)"
    with open(hdmi[0]) as f:
        if f.read().strip() != "connected":
            return ("nothing on HDMI-A-1: with no display the refusals come too seldom to fail "
                    "in a minute (attach one, or force an EDID)")
    return None


@pytest.mark.skipif(real_dpi_and_hdmi_on_one_card() is not None,
                    reason=real_dpi_and_hdmi_on_one_card() or "")
def test_dpipixels_and_a_virtual_matrix_on_one_real_card(fppd):
    """Device only (run-local.sh on a Pi 0-4 whose config.txt loads the DPI
    overlay; verified on a Pi 3B+ with a PiHat virtual EEPROM): DPIPixels on
    DPI-1 (two strings of 541 and 448 pixels, as in the report: a 1920x335
    framebuffer at 20 Hz) and the report's 384x216 Virtual Matrix on HDMI-A-1,
    a display attached, test mode at 20 fps, and twice a change of
    the DPI refresh (to 25 Hz and back) on the way: no page flip refused but
    a few as the outputs come up, and the output thread keeps to its frame.

    Regression: 4bea0042e (#3171).  WaitForPendingFlip() polled the card's shared fd
    once and took its own flip for done.  When the event was the other
    output's, the next flip found its CRTC still busy, was refused (EBUSY)
    and fell back to a SetPlane commit costing several vblanks; with the
    lock held through the waits as well, the output thread's sends ran over
    its 50 ms frame.  At 668641b4a on the 3B+: 236 DPI and 204 HDMI flips
    refused in a minute, 80-108 slow frames every 10 s, steadily, with no
    wait timeouts.  With no display (the report's case: fppd's stand-in
    1080p60) the same build refused only 0-1 a run here, too few to fail on,
    so this skips without one; a display attached, or an EDID forced
    (drm.edid_firmware= with video= and vc4.force_hotplug=), it refuses
    dozens.  The fake card's flips are never late, so there the bug shows
    only as the held lock (the first two tests); the refusals need vc4.

    As the outputs come up, the HDMI output's first flip can time out
    behind DPIPixels' modeset and a refusal or three follow it.  So in the
    first 15 s a few are let by, but only beside a wait timeout.

    No strings or display need be connected; the strings' pins (P1-7, P1-29)
    are driven.  Two strings need no cape license.  Stop the device's own
    fppd first: while it holds DRM master, the test fppd can't drive the
    card and would flip nothing (it fails here, rather than pass on that).
    """
    from test_command_socket import send
    from test_dpi_pixels import output, write_cape
    write_cape("TestDPIShared", {"outputs": [{"pin": "P1-7"}, {"pin": "P1-29"}]})
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [
        {"type": "DPIPixels", "subType": "TestDPIShared", "enabled": 1, "startChannel": 1,
         "channelCount": -1, "outputCount": 2, "outputs": [output(0, 541, 0), output(1, 448, 1623)]}]})
    fppd.write("config/co-other.json", {"channelOutputs": [matrix("HDMI-A-1", 3001, 384, 216)]})
    fppd.settings(LogLevel_ChannelOut="info")
    fppd.start()
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on DPI-1")
    fppd.wait_for(lambda: "KMSFrameBuffer: HDMI-A-1 mode" in fppd.log(), timeout=15,
                  what="the Virtual Matrix on HDMI-A-1")
    fppd.command("Test Start", 50, "RGB Cycle", f"1-{3000 + 384 * 216 * 3}", "R-G-B")
    time.sleep(15)
    started = fppd.log()
    time.sleep(12)
    # The output thread runs at the bridging interval while no sequence plays,
    # and DPIPixels follows it: 25 Hz, then 20 again, each a modeset.
    send("SetSetting,E131BridgingInterval,40,", timeout=5)
    time.sleep(12)
    send("SetSetting,E131BridgingInterval,50,", timeout=5)
    time.sleep(12)
    fppd.command("Test Stop")
    log = fppd.log()

    assert "Failed to get DRM master" not in log, \
        "another process (the device's own fppd?) holds DRM master: stop it and run this again"
    # Each needs DRM master: DPIPixels' modeset to its refresh, the matrix's first frame.
    assert "KMSFrameBuffer DPI-1: refresh set to 20Hz" in log, "DPIPixels never set DPI-1 to its 20 Hz"
    assert "EnableDisplay: SUCCESS for HDMI-A-1" in log, "the test fppd never put a frame up on HDMI-A-1"
    changes = re.findall(r"DPIPixels: DPI refresh -> (\d+) fps \(idle", log[len(started):])
    assert changes == ["25", "20"], f"the DPI refresh didn't change to 25 Hz and back (precondition): {changes}"

    for c, (timeouts, refused) in totals(started).items():
        assert refused <= 3 and (refused == 0 or timeouts > 0), \
            (f"{c}: {refused} page flips refused in the first 15 s, beside {timeouts} wait timeouts "
             "(as the outputs come up, a few may follow a timeout; none without one)")
    before, after = totals(started), totals(log)
    refused = {c: n - before.get(c, (0, 0))[1] for c, (_, n) in after.items() if n != before.get(c, (0, 0))[1]}
    slow = [int(m.group(1)) for m in SLOW.finditer(log[len(started):])]
    assert not refused, (f"page flips refused in the 36 s after the first 15 (two DPI refresh changes "
                         f"among them): {refused}; slow output-thread warnings: {len(slow)}")
    # A modeset holds the output thread's send through a vblank or two: one
    # slow frame per refresh change.
    assert len(slow) <= len(changes), (f"{len(slow)} slow output-thread warnings in the 36 s after the "
                                       f"first 15, sends up to {max(slow) / 1000:.0f} ms of a 50 ms frame")
