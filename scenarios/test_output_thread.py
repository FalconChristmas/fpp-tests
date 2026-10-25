"""The channel output thread: starting, idling and stopping around a show.

The thread exits when nothing has needed output for 2.5 s, and every start
(a sequence, an effect, test mode) has to bring it back. These scenarios hold
the thread at the edges of that window with shims and check that output
comes back every time.
"""

import os
import time

import pytest

import shims
from ddp import DdpReceiver
from eseq import model_frames, write_eseq
from fppd import sanitizer
from fseq import unique_frames
from show import CHANNELS, ddp_output, install, status

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

    Also guards af5a02811 under TSan: RunThread and ThreadIsRunning were
    volatile ints, so the main loop's stop (RunThread = 0) raced the thread's
    read of it, and the starter's unlocked wait for ThreadIsRunning raced the
    thread setting it.
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


@pytest.mark.parametrize("offset", [0.3, 0.8, 1.3])
def test_a_range_overlay_set_while_the_output_thread_idles(fppd, offset):
    """A channel range set over the API while the output thread is in its
    2.5 s idle wait goes on the wire within a second, not when the wait runs
    out.

    Test mode is started and stopped, so the thread is running and then
    idle; the range is set `offset` s into the idle wait.

    Regression: 8cdd81a3e. PUT /overlays/range added the range without
    counting a start request (an overlay model's state change does), so the
    idle wait slept on: the range stayed dark for the rest of the 2.5 s, then
    the thread stopped the outputs and the main loop started it again. Every
    range PUT just after fppd started waited this out.
    """
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Test Start", "100", "RGB Cycle", f"1-{CHANNELS}", "R-G-B")
        assert rx.wait_frames(3, timeout=8, since=time.monotonic()), "test mode sent nothing"
        fppd.command("Test Stop")
        time.sleep(offset)
        since = time.monotonic()
        fppd.request("PUT", "/overlays/range/1-30", {"Value": 42})
        lit = bytes([42] * 30)
        fppd.wait_for(lambda: any(f[:30] == lit for _, f in rx.snapshot(since)), timeout=4,
                      what="the range on the wire")
        took = next(t for t, f in rx.snapshot(since) if f[:30] == lit) - since
        assert took < 1.0, f"the range went out {took:.2f} s after it was set {offset} s into the idle wait"


def test_fppd_stops_without_waiting_out_the_idle_window(fppd):
    """fppd stopped while the output thread is in its 2.5 s idle wait exits
    promptly, not when that wait runs out.

    Test mode is started and stopped, so the thread is running and then
    idle; SIGTERM lands 0.3 s into the idle wait.

    Regression: 4ee74b20e. StopChannelOutputThread() cleared RunThread and
    polled for the thread to exit, but nothing woke the idle wait: every
    shutdown (and every restart from the UI) sat out the rest of it, about
    2.2 s here.

    TSan's own exit (flushing its reports, tearing down its shadow memory)
    takes 1.3-1.5 s on its own, so under TSan the limit is 2.5 s: still well
    short of the 3.5 s or more the unfixed stop takes there.

    Also guards af5a02811 under TSan: ThreadIsRunning was a volatile int,
    and StartChannelOutputThread()'s unlocked wait for it raced the thread
    setting it.
    """
    limit = 2.5 if sanitizer() == "tsan" else 1.0
    fppd.start()
    fppd.command("Test Start", "100", "RGB Cycle", "1-30", "R-G-B")
    time.sleep(1)
    fppd.command("Test Stop")
    time.sleep(0.3)
    started = time.monotonic()
    rc = fppd.stop()
    took = time.monotonic() - started
    fppd.exit_expected = True
    assert rc == 0, f"fppd exited with {rc} on SIGTERM\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    assert took < limit, f"fppd took {took:.2f} s to exit on SIGTERM\n{fppd.tail()}"


def test_a_threaded_output_without_a_double_buffer_takes_each_frame_by_pointer(fppd):
    """A ModelPixelStrings output (a threaded output that hands each frame to
    its worker by pointer, with no double buffer of its own) carries test
    mode's colour cycle into its model for 5 s: the model's channels reach
    the wire, changing, and (under TSan) nothing races.

    Regression: 8cb795683 (verify with --flavor tsan). SendData() stored
    the frame pointer with no lock, and the worker read it after releasing
    the send lock, so each frame's store raced the worker still sending the
    previous one -- on every such output that sends more than a frame.
    """
    from test_output_model_pixel_strings import (HEIGHT, WIDTH, ddp_model_channels, model, mps,
                                                 vstring)
    model(fppd)
    fppd.write("config/co-other.json",
               mps([vstring(start=30 * i, pixels=10) for i in range(HEIGHT)]))
    fppd.write("config/co-universes.json", ddp_model_channels())
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(WIDTH * HEIGHT * 3) as rx:
        fppd.start()
        fppd.wait_for(lambda: "Calling Init() on ModelPixelStrings output" in fppd.log(),
                      timeout=10, what="the ModelPixelStrings output to load")
        fppd.command("Test Start", "100", "RGB Cycle", f"1-{30 * HEIGHT}", "R-G-B")
        time.sleep(5)
        fppd.command("Test Stop")
        seen = {f for _, f in rx.snapshot() if any(f)}
    assert len(seen) >= 3, f"{len(seen)} distinct lit frames of the model reached the wire"



def test_a_sequence_started_as_the_thread_picks_the_bridging_rate_plays_at_its_own(fppd):
    """A 40 fps sequence the UI starts (the command socket's StartSequence,
    with no playlist to correct its timing) while the output thread is
    choosing the bridging interval, for a pass with nothing running, plays at
    40 fps, not at the 20 fps bridging rate.

    co_seqcheckhold.so holds the thread 1 s in each pass's "is a sequence
    running?" check, made under the status lock, when the answer is no, and
    delays the start 0.3 s after the open (which waits for that lock), so the
    start lands in the next hold. Test mode keeps the thread going; once it
    stops, the next passes find nothing running, and the sequence starts
    1.5 s after the stop. Three rounds.

    Regression: 38d8335dc. SetChannelOutputRefreshRate() stored the
    sequence's frame time without the status lock, so the thread, which had
    just seen no sequence running, stored the bridging interval over it, and
    the whole sequence ran at that.
    """
    from test_command_socket import send
    frames = unique_frames(400, CHANNELS)  # 10 s at 25 ms
    lookup = {f: i for i, f in enumerate(frames)}
    install(fppd, frames, step_ms=25)
    holds = os.path.join(fppd.media, "tmp", "holds")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("co_seqcheckhold.c")],
                   extra_env={"CO_SEQHOLD_MS": "1000", "CO_SEQHOLD_START_MS": "300",
                              "CO_SEQHOLD_LOG": holds})
        for round in range(3):
            fppd.command("Test Start", "100", "RGB Cycle", f"1-{CHANNELS}", "R-G-B")
            assert rx.wait_frames(2, timeout=10, since=time.monotonic()), "test mode sent nothing"
            fppd.command("Test Stop")
            time.sleep(1.5)
            send("StartSequence,Show.fseq,0")
            fppd.wait_for(lambda: status(fppd).get("current_sequence") == "Show.fseq",
                          timeout=10, what="the sequence to start")
            time.sleep(1.5)  # past the hold the start landed in
            since = time.monotonic()
            time.sleep(2)
            played = [t for t, f in rx.snapshot(since) if f in lookup]
            send("StopSequence")
            fppd.wait_for(lambda: status(fppd).get("current_sequence") == "", timeout=10,
                          what="the sequence to stop")
            assert len(played) >= 60, \
                f"round {round + 1}: {len(played)} sequence frames in 2 s of a 40 fps sequence"
    assert os.path.exists(holds), "the shim never held the output thread's check"


def test_a_double_buffered_output_sends_the_blanking_frame_that_ends_a_sequence(fppd):
    """A sequence playing to a threaded, double-buffered output (GenericSerial
    on a pty) and stopped leaves the port's last packet all zeros: the
    blanking frame goes out although no frame follows it.

    co_lostwake.so holds the output's worker 1 s between finding no frame
    pending and starting its wait for one. The stop is sent 0.1 s after a
    packet reaches the pty, so the blanking frame arrives inside that hold.
    Three rounds.

    Regression: ad5e8a540. SendData() raised the frame flag and notified
    without the worker's lock, against a wait with no predicate, so a frame
    handed over between the worker's check and its wait was notified to
    nobody and sat until the next one -- for the blanking frame, forever,
    and the lights stayed lit.
    """
    from serial import PtyReader
    frames = unique_frames(400, 100)
    with PtyReader() as pty:
        install(fppd, frames)
        fppd.write("config/co-universes.json", {"channelOutputs": []})
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "GenericSerial", "enabled": 1, "startChannel": 1, "channelCount": 100,
            "description": "dmx", "device": pty.device, "speed": 115200,
            "header": "HDR", "footer": ""}]})
        fppd.start(preload=[shims.build("co_lostwake.c")],
                   extra_env={"CO_LOSTWAKE_DEVICE": "/dev/" + pty.device, "CO_LOSTWAKE_MS": "1000"})

        def packets():
            with pty.lock:
                return bytes(pty.data).split(b"HDR")[1:]

        for round in range(3):
            before = len(packets())
            fppd.command("Start Playlist", "Show", "false", "false")
            fppd.wait_for(lambda: any(p[:100] in frames for p in packets()[before:]), timeout=10,
                          what="the sequence on the pty")
            seen = len(packets())
            fppd.wait_for(lambda: len(packets()) > seen, timeout=10, what="the next packet")
            time.sleep(0.1)  # the worker has sent it and is held before its wait
            fppd.command("Stop Now")
            fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                          what="the playlist to stop")
            time.sleep(3)
            last = packets()[-1]
            assert last == bytes(100), \
                f"round {round + 1}: the port's last packet is {last[:12].hex(' ')}..., not blank"



def test_outputs_saved_while_the_output_thread_is_inside_a_slow_send(fppd):
    """Saving the outputs while the output thread is inside a send that takes
    450 ms replaces them cleanly: five saves, fppd lives and the new output
    sends after each.

    The DDP output is unthreaded, so it sends on the output thread, and
    co_slowsendmmsg.so makes each send there take 450 ms; test mode runs at
    the 500 ms bridging interval, so the thread spends nine tenths of its
    time inside the old output's SendData() and still idles between frames.

    Regression: dca75838a. ReloadChannelOutputsForFile() unlinked the old
    outputs and deleted them after a 100 ms sleep, which is no barrier
    against an output cycle longer than that: the thread was still in the
    freed output's send (a heap-use-after-free).
    """
    def config(description):
        c = ddp_output(CHANNELS)
        c["channelOutputs"][0]["threaded"] = 0
        c["channelOutputs"][0]["universes"][0]["description"] = description
        return c

    fppd.write("config/co-universes.json", config("a"))
    fppd.settings(DisableFakeNetworkBridges="1", E131BridgingInterval="500")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("co_slowsendmmsg.c")], extra_env={
            "CO_SLOWSENDMMSG_THREAD": "FPP-ChannelOut", "CO_SLOWSENDMMSG_MS": "450"})
        fppd.command("Test Start", "100", "RGB Cycle", f"1-{CHANNELS}", "R-G-B")
        assert rx.wait_frames(2, timeout=10), "test mode sent nothing"
        for i in range(5):
            time.sleep(1.1)  # a save in a later second, as a person makes it
            fppd.write("config/co-universes.json", config(f"save {i}"))
            fppd.wait_for(lambda: fppd.log().count("Calling Init() on UDPOutput output") >= i + 2,
                          timeout=10, what=f"the outputs to reload for save {i + 1}")
            assert rx.wait_frames(2, timeout=10, since=time.monotonic()), \
                f"nothing on the wire after save {i + 1}"
        fppd.command("Test Stop")


def test_outputs_saved_while_every_cycle_runs_over_its_frame_time(fppd):
    """Saving the outputs while every output cycle takes longer than its
    frame time still reloads them: three saves, each replaced within a few
    seconds, and the new output sends after each.

    As above, but each send takes 300 ms against the default 50 ms bridging
    interval, so the thread is always behind and never waits between frames.

    Regression: f2e1e39b2. The output thread let go of outputThreadLock
    only in its wait for the next frame, which it skips while it is behind,
    so the reload's lock() in ReloadChannelOutputsForFile() waited for as
    long as the outputs stayed slow: the main loop stopped there, and the
    outputs could not be replaced to fix them short of restarting fppd.
    """
    def config(description):
        c = ddp_output(CHANNELS)
        c["channelOutputs"][0]["threaded"] = 0
        c["channelOutputs"][0]["universes"][0]["description"] = description
        return c

    fppd.write("config/co-universes.json", config("a"))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(preload=[shims.build("co_slowsendmmsg.c")], extra_env={
            "CO_SLOWSENDMMSG_THREAD": "FPP-ChannelOut", "CO_SLOWSENDMMSG_MS": "300"})
        fppd.command("Test Start", "100", "RGB Cycle", f"1-{CHANNELS}", "R-G-B")
        assert rx.wait_frames(2, timeout=10), "test mode sent nothing"
        for i in range(3):
            time.sleep(1.1)  # a save in a later second, as a person makes it
            fppd.write("config/co-universes.json", config(f"save {i}"))
            fppd.wait_for(lambda: fppd.log().count("Calling Init() on UDPOutput output") >= i + 2,
                          timeout=10, what=f"the outputs to reload for save {i + 1}")
            assert rx.wait_frames(2, timeout=10, since=time.monotonic()), \
                f"nothing on the wire after save {i + 1}"
        fppd.command("Test Stop")


def test_an_outputs_disabled_preset_that_enables_an_overlay_model(fppd):
    """An OUTPUTS_DISABLED command preset that enables an overlay model,
    fired as the output thread idles out after startup, brings output back:
    the model's frames reach the wire, and the overlay API still answers.

    Regression: f91a1d748. The exiting thread fired the preset holding the
    status lock, with ThreadIsRunning already clear; enabling the model
    restarts output, which waited on that lock (or on a replacement thread
    parked behind the exiting one) forever. The command held the overlay
    models' lock while it waited, so /api/overlays/models hung from then on.
    """
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": "Lit", "Type": "Channel", "StartChannel": 1, "ChannelCount": FX,
        "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": 1, "StrandsPerString": 1}]})
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "OUTPUTS_DISABLED", "command": "Overlay Model State",
        "args": ["Lit", "Enabled"], "presetSlot": 0}]})
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        # the startup thread idles out 2.5 s after its last frame, and the
        # preset it fires on the way out enables the model
        fppd.wait_for(lambda: any(m.get("isActive") for m in fppd.get("/overlays/models", timeout=5)),
                      timeout=15, interval=0.5, what="the preset to enable the model")
        assert rx.wait_frames(10, timeout=5, since=time.monotonic()), \
            "the enabled model's output never restarted"
        fppd.get("/overlays/models", timeout=5)
