"""The channel output thread: starting, idling and stopping around a show.

The thread exits when nothing has needed output for 2.5 s, and every start
(a sequence, an effect, test mode) has to bring it back. These scenarios hold
the thread at the edges of that window with shims and check that output
comes back every time.
"""

import time

import pytest

import shims
from ddp import DdpReceiver
from eseq import model_frames, write_eseq
from show import CHANNELS, ddp_output

FX = 30  # the effect's model: channels 1-30


def effect_frames_since(rx, frames, since):
    return [f for _, f in rx.snapshot(since) if f[:FX] in frames]


def test_a_start_while_the_output_thread_winds_down(fppd):
    """An effect started while the output thread is between deciding it is
    idle and starting its 2.5 s idle wait gets its frames on the wire, and
    keeps getting them.

    co_latewait.so holds the thread 1.5 s at that point, with the status
    lock held, as a thread that has checked and not yet waited is. The
    effect starts 0.6 s into that hold. Three rounds.

    Regression: 135b67f31. StartChannelOutputThread() notified without the
    status lock, so the notify was lost; the start then spawned a
    replacement thread, and the old thread's timed-out wait cleared
    RunThread under it. Both exited a second or so later, and the effect
    played on with nothing on the wire (the main loop restarts the thread
    for test mode and overlays, not for effects).
    """
    frames = model_frames(40, FX)
    write_eseq(fppd, "fx", frames, 1)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("co_latewait.c")], extra_env={"CO_LATEWAIT_MS": "1500"})
        for round in range(3):
            # The thread idles out after startup and after each round (2.5 s,
            # plus the shim's hold); test mode then starts a fresh one.
            time.sleep(5)
            fppd.command("Test Start", "100", "RGB Cycle", f"{FX + 1}-{CHANNELS}", "R-G-B")
            assert rx.wait_frames(10, timeout=5, since=time.monotonic()), "test mode sent nothing"
            fppd.command("Test Stop")
            time.sleep(0.6)  # the thread has gone idle and is held before its wait
            since = time.monotonic()
            fppd.command("Effect Start", "fx", 0, "true", "false")
            fppd.wait_for(lambda: effect_frames_since(rx, frames, since), timeout=6,
                          what=f"effect frames in round {round + 1}")
            # and they keep coming: past the old thread's idle timeout, which
            # took a replacement thread down with it
            time.sleep(4)
            assert effect_frames_since(rx, frames, time.monotonic() - 1), \
                f"round {round + 1}: the running effect stopped reaching the wire"
            fppd.command("Effect Stop", "fx")


@pytest.mark.parametrize("ms", [80, 160], ids=["slow", "very slow"])
def test_slow_frames_are_logged_once_not_every_frame(fppd, ms):
    """While every frame is slow, "SLOW Output Thread" is logged when it
    starts and then every 10 s, not once a frame.

    The DDP output is unthreaded, so it sends on the output thread, and
    co_slowsendmmsg.so makes each send there take 80 ms (slow: over 50 ms)
    or 160 ms (very slow: over 150 ms).

    Regression: d371143c1. Once three frames in a row were slow, every
    following slow frame wrote the line, a dozen a second here, to the SD
    card for as long as it lasted; and a very slow frame set the counter to
    3, which the "> 3" check never passed, so very slow frames were never
    logged at all.
    """
    config = ddp_output(CHANNELS)
    config["channelOutputs"][0]["threaded"] = 0
    fppd.write("config/co-universes.json", config)
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("co_slowsendmmsg.c")], extra_env={
            "CO_SLOWSENDMMSG_THREAD": "FPP-ChannelOut", "CO_SLOWSENDMMSG_MS": str(ms)})
        fppd.command("Test Start", "100", "RGB Cycle", f"1-{CHANNELS}", "R-G-B")
        assert rx.wait_frames(5, timeout=10), "test mode sent nothing"
        time.sleep(6)
    slow = fppd.log().count("SLOW Output Thread")
    assert 1 <= slow <= 2, f"{slow} SLOW Output Thread lines in about 6 s of slow frames"


def test_multisync_send_failures_are_logged_once_not_every_packet(fppd):
    """A master whose MultiSync multicast sends all fail (ENOBUFS, as on a
    busy Wi-Fi interface) logs it once, not once per sync packet.

    co_failsendto.so fails every sendto() to the MultiSync port. fppd only
    multicasts on a non-loopback interface, so a dummy one gives it one.

    Regression: d371143c1. Every failed broadcast or multicast send logged
    "Unable to send packet", one line per sync packet per interface.
    """
    from fseq import unique_frames
    from multisync import PORT
    from show import install
    from test_multisync_systems import interface

    with interface("10.77.0.1"):
        install(fppd, unique_frames(400, CHANNELS))
        fppd.settings(MultiSyncEnabled="1", MultiSyncUnicast="0", MultiSyncRemotes='""')
        fppd.start(preload=[shims.build("co_failsendto.c")],
                   extra_env={"CO_FAILSENDTO_PORT": str(PORT)})
        fppd.command("Start Playlist", "Show", "false", "false")
        time.sleep(5)
    failed = fppd.log().count("Unable to send packet")
    assert 1 <= failed <= 2, f"{failed} 'Unable to send packet' lines in 5 s of failed sync sends"


def test_a_start_during_the_last_pass_before_idling(fppd):
    """An effect started while the output thread is in its last pass before
    going idle (sending, after it sampled what needs output) gets its frames
    on the wire, and keeps getting them.

    The DDP output is unthreaded, so its sendmmsg() runs on the output
    thread, and co_slowsendmmsg.so makes each one take 300 ms. The effect
    starts at offsets from 0.3 to 1.05 s after test mode stops, so one of
    them lands in the idle-deciding pass whatever its phase.

    Regression: 74d226ec1. The idle wait compared the start-request counter
    with a snapshot taken at the wait, after the pass had sent. A start
    counted during the send was inside that snapshot, and too late for the
    pass's check of what needs output; the starter saw a running thread and
    returned. The thread idled out 2.5 s later and nothing restarted it for
    an effect.
    """
    frames = model_frames(40, FX)
    write_eseq(fppd, "fx", frames, 1)
    config = ddp_output(CHANNELS)
    config["channelOutputs"][0]["threaded"] = 0
    fppd.write("config/co-universes.json", config)
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("co_slowsendmmsg.c")], extra_env={
            "CO_SLOWSENDMMSG_THREAD": "FPP-ChannelOut", "CO_SLOWSENDMMSG_MS": "300"})
        for offset in (0.3, 0.45, 0.6, 0.75, 0.9, 1.05):
            time.sleep(5)  # the thread idles out
            fppd.command("Test Start", "100", "RGB Cycle", f"{FX + 1}-{CHANNELS}", "R-G-B")
            assert rx.wait_frames(3, timeout=8, since=time.monotonic()), "test mode sent nothing"
            fppd.command("Test Stop")
            time.sleep(offset)
            fppd.command("Effect Start", "fx", 0, "true", "false")
            time.sleep(5)  # past the idle wait of a thread that missed the start
            assert effect_frames_since(rx, frames, time.monotonic() - 1.5), \
                f"effect started {offset} s after test mode stopped: nothing on the wire"
            fppd.command("Effect Stop", "fx")
