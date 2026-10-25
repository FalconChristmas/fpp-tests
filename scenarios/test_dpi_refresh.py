"""DPIPixels' refresh rate, on a fake DPI panel.

DPIPixels sizes the DPI framebuffer to its longest string once, and then sets
the output's frame rate by changing only the vertical blanking, with a
modeset (KMSFrameBuffer::SetRefreshRate()): the running sequence's rate, or
with nothing playing the E1.31 bridging interval's.

Device only: run with run-local.sh on a Raspberry Pi (DPIPixels is built
only there). No DPI panel is needed: fakedrm.so stands in for the display
card, with a DPI-1 connector running the mode FPP's DPI overlay sets up, and
logs every modeset. Two strings on the Pi's own pins need no cape license.
"""

import os
import re
import time

import pytest

import fakedrm
from test_dpi_pixels import on_pi, write_cape

pytestmark = pytest.mark.skipif(not on_pi(), reason="DPIPixels is built for a Raspberry Pi")

CAPE = {"outputs": [{"pin": "P1-7"}, {"pin": "P1-29"}]}


def string(port, start, pixels=10):
    return {"portNumber": port, "protocol": "ws2811", "virtualStrings": [
        {"description": f"port{port}", "startChannel": start, "pixelCount": pixels, "groupCount": 0,
         "reverse": 0, "colorOrder": "RGB", "nullNodes": 0, "endNulls": 0, "zigZag": 0,
         "brightness": 100, "gamma": "1.0"}]}


def setup(fppd):
    write_cape("TestDPIRate", CAPE)
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [
        {"type": "DPIPixels", "subType": "TestDPIRate", "enabled": 1, "startChannel": 1,
         "channelCount": 60, "outputCount": 2, "outputs": [string(0, 0), string(1, 30)]}]})
    fppd.settings(LogLevel_ChannelOut="info")


def modesets(fppd):
    """[(refresh Hz, refused)] for every modeset the fake card saw."""
    out = []
    for line in fakedrm.log(fppd).splitlines():
        m = re.match(r"(refuse )?crtc \d+x\d+@(\d+)", line)
        if m:
            out.append((int(m.group(2)), bool(m.group(1))))
    return out


def test_a_refused_refresh_change_is_tried_again(fppd):
    """DPIPixels idle at the bridging interval's 20 fps, test mode running so
    the output thread sends frames; the interval is set
    to 40 ms (25 fps) while the display refuses modesets, then the display
    takes them again: the 25 Hz modeset is retried and lands.

    Regression: e82453c02. SetRefreshRate() wrote the new timing into the
    mode it believed the CRTC was running before the modeset, so after the
    refusal the next call found the rate "already" set and returned true:
    the display stayed at 20 Hz while DPIPixels thought it ran 25.
    """
    from test_command_socket import send
    setup(fppd)
    block = os.path.join(fppd.media, "tmp", "no-modeset")
    preload, env = fakedrm.dpi_env(fppd, fail_modeset=block)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    fppd.wait_for(lambda: (20, False) in modesets(fppd), timeout=10,
                  what="the 20 fps idle rate to be set")
    # Something for the output thread to send, at the bridging interval.
    fppd.command("Test Start", 1000, "RGB Cycle", "1-60", "R-G-B")
    with open(block, "w"):
        pass
    send("SetSetting,E131BridgingInterval,40,", timeout=5)
    fppd.wait_for(lambda: (25, True) in modesets(fppd), timeout=15,
                  what="a 25 Hz modeset to be refused (precondition)")
    os.unlink(block)
    time.sleep(2)
    assert (25, False) in modesets(fppd), \
        f"the 25 Hz rate was never set after the refusal: {modesets(fppd)}\n{fppd.tail()}"
    fppd.command("Test Stop")


def install_sequence(fppd, name, step_ms, seconds=3):
    from fseq import unique_frames, write_fseq
    from show import playlist, sequence_entry
    write_fseq(os.path.join(fppd.media, "sequences", name + ".fseq"),
               unique_frames(seconds * 1000 // step_ms, 60), step_ms=step_ms)
    fppd.write(f"playlists/{name}.json", playlist(name, [sequence_entry(name + ".fseq")]))


def play(fppd, name):
    fppd.command("Start Playlist", name, "false", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                  what=f"{name} to play")


def wait_idle(fppd):
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "idle", timeout=15,
                  what="the sequence to end")


def test_each_sequence_gets_its_own_refresh_rate(fppd):
    """A 25 fps sequence and then a 20 fps one on DPI pixels: the DPI's
    refresh follows each, with a modeset on the running output -- no
    reboot, and the framebuffer is never rebuilt.

    Regression: 3d7430bf8 (a feature). The DPI ran the one rate its
    config.txt overlay was booted with, whatever the sequence's step. The
    control undoes only the runtime half (PrepData() never asks for a rate).
    """
    setup(fppd)
    install_sequence(fppd, "Fast", 40)
    install_sequence(fppd, "Slow", 50)
    preload, env = fakedrm.dpi_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    play(fppd, "Fast")
    fppd.wait_for(lambda: (25, False) in modesets(fppd), timeout=5,
                  what="a 25 Hz modeset for the 25 fps sequence")
    wait_idle(fppd)
    before = len(modesets(fppd))
    play(fppd, "Slow")
    fppd.wait_for(lambda: (20, False) in modesets(fppd)[before:], timeout=5,
                  what="a 20 Hz modeset for the 20 fps sequence")
    wait_idle(fppd)
    assert fppd.log().count("DPIPixels: framebuffer 1920x") == 1, "the output was rebuilt"


def test_an_idle_output_drops_to_the_idle_rate_after_a_sequence(fppd):
    """A 25 fps sequence ends, and the output goes on with test mode at the
    bridging interval's 20 fps: a few seconds later the DPI is retimed to
    20 Hz, and the next 25 fps sequence takes it straight back to 25.

    Regression: 7b29880fe. With nothing playing, the DPI kept whatever rate
    the last sequence left behind, which nothing lowered or restored (that
    commit raised it to the maximum when idle; 80a4c8ebe made the idle rate
    the bridging interval's). The control drops the idle branch.
    """
    setup(fppd)
    install_sequence(fppd, "Fast", 40)
    preload, env = fakedrm.dpi_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    play(fppd, "Fast")
    fppd.wait_for(lambda: (25, False) in modesets(fppd), timeout=5,
                  what="a 25 Hz modeset for the 25 fps sequence")
    wait_idle(fppd)
    before = len(modesets(fppd))
    fppd.command("Test Start", 1000, "RGB Cycle", "1-60", "R-G-B")
    fppd.wait_for(lambda: (20, False) in modesets(fppd)[before:], timeout=8,
                  what="the idle output to be retimed to 20 Hz")
    fppd.command("Test Stop")
    before = len(modesets(fppd))
    play(fppd, "Fast")
    fppd.wait_for(lambda: (25, False) in modesets(fppd)[before:], timeout=3,
                  what="the next sequence's 25 Hz, straight away")
    wait_idle(fppd)


def test_a_refresh_that_divides_the_new_rate_is_kept(fppd):
    """A 40 fps sequence and then a 20 fps one: the DPI goes to 40 Hz for
    the first and stays there for the second, scanning each of its frames
    twice, with no modeset (each one cuts the WS stream mid-frame).

    Regression: 80a4c8ebe (its rate-retention half; the idle half is
    test_an_idle_output_drops_to_the_idle_rate_after_a_sequence). Every
    change of sequence rate was a modeset, so the common mix of 20 and 40
    fps sequences glitched the strings at each switch.
    """
    setup(fppd)
    install_sequence(fppd, "Forty", 25)
    install_sequence(fppd, "Twenty", 50)
    preload, env = fakedrm.dpi_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    play(fppd, "Forty")
    fppd.wait_for(lambda: (40, False) in modesets(fppd), timeout=5,
                  what="a 40 Hz modeset for the 40 fps sequence")
    wait_idle(fppd)
    before = len(modesets(fppd))
    play(fppd, "Twenty")
    wait_idle(fppd)
    assert not modesets(fppd)[before:], \
        f"the 20 fps sequence after a 40 fps one modeset the DPI: {modesets(fppd)[before:]}"


def test_an_idle_dpi_output_starts_at_the_idle_rate(fppd):
    """DPIPixels comes up on a remote with nothing driving output: at Init
    the DPI is retimed from the string's maximum (over 1000 Hz for these
    short strings) to the bridging interval's 20 fps, and stays there.

    Regression: ebe9530bb. KMS brought the DPI up at the maximum and only
    PrepData() lowered it, which nothing calls on an idle or remote box: the
    strings were rescanned at hundreds of Hz from boot until the first
    sequence. The box here is a remote with no bridge inputs and nothing
    playing, so nothing drives output and PrepData() is never called (a
    player's output thread runs a few frames at startup, which lowered the
    rate anyway).
    """
    setup(fppd)
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    preload, env = fakedrm.dpi_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    time.sleep(5)
    sets = modesets(fppd)
    assert sets and sets[-1] == (20, False), f"the idle DPI runs {sets[-1:] or 'its boot mode'}: {sets}"


def test_a_refresh_change_held_off_by_media_is_made_once_the_media_goes(fppd, audio):
    """A video consumer holds the DPI connector (a camera group pointed at
    DPI-1) when a 40 fps sequence starts: the DPI's refresh is not changed
    under the camera, and as soon as the camera is taken off (an output
    reload with no consumers) the 40 Hz modeset is made, while the
    sequence still plays.

    Regression: de322e113 (its SetRefreshRate() half). With media owning
    the connector the change was deferred but reported as made, so
    DPIPixels believed it ran 40 fps and never asked again: the display
    stayed at 20 Hz for the rest of the sequence.
    """
    from test_command_socket import send
    from test_video import fake_kms_env, hdmi_consumer, kms_events, source
    from test_video import setup as video_setup
    video_setup(fppd, [hdmi_consumer(1, connector_id=35, card="/dev/dri/card0", group=3)],
                [source("videotestsrc", pattern="smpte")])
    setup(fppd)
    install_sequence(fppd, "Forty", 25, seconds=12)
    fppd.settings(LogLevel_MediaOut="info")
    preload, env = fakedrm.dpi_env(fppd)
    env.update(fake_kms_env(fppd))
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: [e for e in kms_events(fppd) if e[0] == "frame" and e[2] == 35],
                  timeout=20, what="the camera's frames on DPI-1")
    play(fppd, "Forty")
    time.sleep(2)
    # The control: the camera's hold really defers the change.
    assert (40, False) not in modesets(fppd), f"the DPI was retimed under the camera: {modesets(fppd)}"
    fppd.write("config/pipewire-video-consumers.json", [])
    send("reloadVideoOutputs", timeout=10)
    fppd.wait_for(lambda: (40, False) in modesets(fppd), timeout=5,
                  what="the 40 Hz modeset once the camera let go of DPI-1")
    assert fppd.get("/fppd/status").get("status_name") == "playing"
    fppd.command("Stop Now")
