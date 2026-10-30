"""Effects: ESEQ files and FSEQ sequences overlaid on the channel data.

A DDP receiver on this machine stands in for the controller, so each check
is made on what fppd actually sends: where an effect lands, what is under it,
and what is left when it stops.
"""

import os
import time

import pytest

from ddp import DdpReceiver
from eseq import eseq_bytes, model_frames, solid, write_eseq
from fseq import solid_frames, unique_frames, write_fseq
from show import CHANNELS, ddp_output, install, playlist, status

# The effect model: 12 channels (four RGB pixels) from channel 11.
START = 11
SIZE = 12
MODEL = slice(START - 1, START - 1 + SIZE)


def outputs_only(fppd):
    """A DDP output and nothing to play: whatever reaches the receiver is the
    effect's doing."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")


def effect_start(fppd, name, start_channel=0, loop=True, bg=False):
    return fppd.command("Effect Start", name, start_channel, "true" if loop else "false",
                        "true" if bg else "false")


def running(fppd):
    return sorted(e["name"] for e in fppd.get("/fppd/effects").get("runningEffects", []))


def last(rx):
    return rx.last() or bytes(CHANNELS)


def wait_output(fppd, rx, predicate, what, timeout=10):
    """Wait until the latest frame on the wire satisfies `predicate`; return it."""
    def check():
        f = last(rx)
        return f if predicate(f) else None
    return fppd.wait_for(check, timeout=timeout, interval=0.05, what=what)


def dark_outside(frame, keep):
    return not any(b for i, b in enumerate(frame) if i not in keep)


def test_effect_draws_its_model_and_clears_when_stopped(fppd):
    """A looping ESEQ effect with nothing else playing drives exactly its
    model's channels, frame after frame from the file, and stopping it
    leaves those channels dark rather than frozen on its last frame
    (70db8abe8, b23ad8b17)."""
    frames = model_frames(40, SIZE)
    write_eseq(fppd, "fx", frames, START)
    outputs_only(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect_start(fppd, "fx")
        wait_output(fppd, rx, lambda f: f[MODEL] in frames, "the effect on its model's channels")
        assert running(fppd) == ["fx"]

        # Over two seconds (40 frames of 50 ms, looping) the model shows a
        # run of different file frames, and nothing lands outside it.
        since = time.monotonic()
        time.sleep(2)
        seen = rx.snapshot(since)
        model = set(range(MODEL.start, MODEL.stop))
        assert all(dark_outside(f, model) for _, f in seen), \
            "the effect wrote outside its model's channels"
        shown = {f[MODEL] for _, f in seen}
        assert shown <= set(frames), "the model showed data that is not in the effect file"
        assert len(shown) >= 10, f"the effect is not advancing: {len(shown)} distinct frames in 2 s"

        fppd.command("Effect Stop", "fx")
        wait_output(fppd, rx, lambda f: not any(f), "the output to go dark after Effect Stop")
        assert running(fppd) == []


def test_stopping_one_of_two_effects_clears_only_its_channels(fppd):
    """Stopping one of two effects darkens its channels while the other
    keeps running.

    Played during a playlist's pause entry: a player with no playlist
    blanks every frame anyway, but during a pause (or a media-only entry)
    nothing redraws the channels, so only the stopped effect's clear range
    can darken them (70db8abe8).
    """
    a = solid(20, SIZE, 0xA1)
    b = solid(20, 6, 0xB2)
    write_eseq(fppd, "A", a, START)
    write_eseq(fppd, "B", b, 41)
    fppd.write("playlists/Wait.json", playlist(
        "Wait", [{"type": "pause", "enabled": 1, "playOnce": 0, "duration": 60}]))
    outputs_only(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Wait", "false", "false")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="the pause entry")
        effect_start(fppd, "A")
        effect_start(fppd, "B")
        wait_output(fppd, rx, lambda f: f[MODEL] == a[0] and f[40:46] == b[0], "both effects")
        fppd.command("Effect Stop", "A")
        wait_output(fppd, rx, lambda f: not any(f[MODEL]) and f[40:46] == b[0],
                    "A's channels dark with B still running")
        time.sleep(0.5)
        assert last(rx)[40:46] == b[0] and not any(last(rx)[MODEL])


def test_start_channel_moves_the_effect(fppd):
    """Effect Start's start channel (1-based, like the file's) places the
    model there instead of where the file says (85567ae9a)."""
    frames = solid(20, SIZE, 0x5A)
    write_eseq(fppd, "fx", frames, START)
    outputs_only(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect_start(fppd, "fx", start_channel=31)
        moved = set(range(30, 30 + SIZE))
        frame = wait_output(fppd, rx, lambda f: f[30:30 + SIZE] == frames[0][:SIZE],
                            "the effect at channel 31")
        assert dark_outside(last(rx), moved), \
            f"the moved effect also drew elsewhere: {list(last(rx))}"


def test_effect_on_a_model_with_no_start_channel_starts_at_the_model(fppd):
    """Effect Start with a model and the start channel left empty (the
    command's default) draws the effect from the model's first channel; a
    start channel given with a model counts from 1 at the model's start.

    Regression: 23c204684 (#2041). An empty start channel was 0, and the
    model's start plus 0 put the effect one channel before the model."""
    frames = solid(20, SIZE, 0x5A)
    write_eseq(fppd, "fx", frames, START)
    outputs_only(fppd)
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": "M", "Type": "Channel", "StartChannel": 31, "ChannelCount": SIZE + 3,
        "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": 1, "StrandsPerString": 1}]})
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Effect Start", "fx", "", "true", "false", "false", "M")
        at_model = set(range(30, 30 + SIZE))
        wait_output(fppd, rx, lambda f: any(f), "the effect on the wire")
        time.sleep(0.3)
        assert last(rx)[30:30 + SIZE] == frames[0] and dark_outside(last(rx), at_model), \
            f"the effect did not land on the model's channels 31-{30 + SIZE}: {list(last(rx)[:60])}"
        fppd.command("Effect Stop", "fx")
        wait_output(fppd, rx, lambda f: not any(f), "the output to go dark after Effect Stop")
        fppd.command("Effect Start", "fx", "4", "true", "false", "false", "M")
        moved = set(range(33, 33 + SIZE))
        wait_output(fppd, rx, lambda f: f[33:33 + SIZE] == frames[0],
                    "the effect at the model's fourth channel")
        assert dark_outside(last(rx), moved), list(last(rx)[:60])


def test_effect_that_does_not_loop_ends_by_itself(fppd):
    """A non-looping effect plays its frames once, then leaves the running
    list and the output dark (f2ab6fef1, 897084f16)."""
    frames = solid(20, SIZE, 0x33)  # one second
    write_eseq(fppd, "once", frames, START)
    outputs_only(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect_start(fppd, "once", loop=False)
        wait_output(fppd, rx, lambda f: f[MODEL] == frames[0], "the effect to show")
        fppd.wait_for(lambda: running(fppd) == [], timeout=10,
                      what="the one-shot effect to finish")
        wait_output(fppd, rx, lambda f: not any(f), "the output to go dark once it ended")


def test_effect_over_a_sequence(fppd):
    """An effect started while a sequence plays replaces the sequence on its
    model's channels only; once it stops, the sequence shows there again."""
    seq = solid_frames(600, CHANNELS, 0x10)  # 30 s
    fx = solid(20, SIZE, 0xC0)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, seq)
        write_eseq(fppd, "fx", fx, START)
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        wait_output(fppd, rx, lambda f: f == seq[0], "the sequence on the wire")

        effect_start(fppd, "fx")
        frame = wait_output(fppd, rx, lambda f: f[MODEL] == fx[0], "the effect over the sequence")
        outside = frame[:MODEL.start] + frame[MODEL.stop:]
        assert set(outside) == {0x10}, "the effect disturbed channels outside its model"

        fppd.command("Effect Stop", "fx")
        wait_output(fppd, rx, lambda f: f == seq[0],
                    "the sequence to show on the model's channels again")
        assert status(fppd).get("status_name") == "playing"


def test_most_recently_started_effect_wins(fppd):
    """Two effects on the same channels: the one started last is drawn on
    top, whichever internal slot it landed in.

    Regression: 94a6af81f. Effects were drawn in slot order, so an effect
    restarted into a lower slot (freed by stopping it) was hidden under
    one started before it.
    """
    a = solid(20, SIZE, 0xAA)
    b = solid(20, SIZE, 0xBB)
    write_eseq(fppd, "A", a, START)
    write_eseq(fppd, "B", b, START)
    outputs_only(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect_start(fppd, "A")                        # slot 0
        effect_start(fppd, "B")                        # slot 1
        wait_output(fppd, rx, lambda f: f[MODEL] == b[0], "B, started last, on top")
        fppd.command("Effect Stop", "A")
        effect_start(fppd, "A")                        # slot 0 again, but newest
        wait_output(fppd, rx, lambda f: f[MODEL] == a[0], "A, restarted last, on top")
        # and it stays on top
        time.sleep(1)
        assert last(rx)[MODEL] == a[0], "the restarted effect fell back under the older one"


def test_stop_by_pattern_and_list(fppd):
    """Effect Stop takes a shell pattern or a comma-separated list of names
    (e6ed9c001), and stops only what matches."""
    for name in ("snow_a", "snow_b", "star"):
        write_eseq(fppd, name, solid(20, SIZE, 0x44), START)
    outputs_only(fppd)
    fppd.start()
    for name in ("snow_a", "snow_b", "star"):
        effect_start(fppd, name)
    assert running(fppd) == ["snow_a", "snow_b", "star"]

    fppd.command("Effect Stop", "snow_*")
    assert running(fppd) == ["star"]

    for name in ("snow_a", "snow_b"):
        effect_start(fppd, name)
    fppd.command("Effect Stop", "star,snow_b")
    assert running(fppd) == ["snow_a"]

    fppd.command("Effects Stop")
    assert running(fppd) == []


def test_fseq_effect_start_options(fppd):
    """FSEQ Effect Start runs a sequence as an effect. Started twice it runs
    twice; "If Not Running" refuses the second start, and "Restart If
    Running" jumps the running one back to its first frame instead of
    starting another (e0555f1d8). If Not Running is 1c7641851."""
    frames = unique_frames(60, CHANNELS)  # 3 s
    write_fseq(os.path.join(fppd.media, "sequences", "Glow.fseq"), frames, step_ms=50)
    outputs_only(fppd)
    lookup = {f: i for i, f in enumerate(frames)}

    def fseq_effect(*opts):
        # name, loop, bg, ifNotRunning, restartIfRunning
        return fppd.command("FSEQ Effect Start", "Glow", "false", "false", *opts)

    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fseq_effect("false", "false")
        wait_output(fppd, rx, lambda f: f in lookup, "the sequence running as an effect")

        fseq_effect("true", "false")
        assert running(fppd) == ["Glow"], "If Not Running started a second copy"

        # Let it get past halfway, then restart it in place.
        wait_output(fppd, rx, lambda f: lookup.get(f, 0) >= 35, "the effect to pass frame 35")
        fseq_effect("false", "true")
        assert running(fppd) == ["Glow"], "Restart If Running started a second copy"
        wait_output(fppd, rx, lambda f: 0 <= lookup.get(f, 99) < 20,
                    "the effect to jump back to its start", timeout=3)
        # Restarted at about 1.8 s in, it now ends about 3 s later -- past
        # when the first start alone would have ended.
        time.sleep(2)
        assert running(fppd) == ["Glow"], "the restarted effect ended on the old schedule"

        fppd.command("FSEQ Effect Stop", "Glow")
        fseq_effect("false", "false")
        fseq_effect("false", "false")
        assert running(fppd) == ["Glow", "Glow"], "a plain second start should run a second copy"


def test_background_effect_starts_with_fppd(fppd):
    """effects/background.eseq starts, looping, when fppd does (94a01b729)."""
    frames = solid(20, SIZE, 0x66)
    write_eseq(fppd, "background", frames, START)
    outputs_only(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        assert running(fppd) == ["background"]
        wait_output(fppd, rx, lambda f: f[MODEL] == frames[0], "the background effect")
        time.sleep(1.5)  # longer than the file: it loops
        assert running(fppd) == ["background"]


def test_pause_background_effects_while_a_sequence_plays(fppd):
    """With pauseBackgroundEffects set, an effect started as a background
    effect is not drawn while a sequence plays; a foreground one still is."""
    seq = solid_frames(600, CHANNELS, 0x10)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, seq)
        write_eseq(fppd, "bg", solid(20, SIZE, 0xB0), START)
        write_eseq(fppd, "fg", solid(20, 3, 0xF0), 41)
        fppd.settings(pauseBackgroundEffects="1")
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        effect_start(fppd, "bg", bg=True)
        effect_start(fppd, "fg")
        wait_output(fppd, rx, lambda f: f[40:43] == b"\xf0" * 3, "the foreground effect")
        time.sleep(0.5)
        assert last(rx)[MODEL] == seq[0][MODEL], "a background effect drew over the sequence"
        assert sorted(running(fppd)) == ["bg", "fg"]


def test_pause_background_effects_changed_while_they_run(fppd):
    """pauseBackgroundEffects can be turned on and off while a background
    effect runs over a sequence: the effect stops drawing and starts again.

    Regression: 2fefcdaaf, under TSan. The settings listener wrote the flag,
    a plain volatile int, while the output thread read it every frame.
    Proved by reverting it on 0ec85d6ae, since its parent has other races.
    (test_bridge_inputs catches the same commit's m_dataProcessed half.)
    """
    seq = solid_frames(600, CHANNELS, 0x10)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, seq)
        write_eseq(fppd, "bg", solid(20, SIZE, 0xB0), START)
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        effect_start(fppd, "bg", bg=True)
        wait_output(fppd, rx, lambda f: f[MODEL] == b"\xb0" * SIZE, "the background effect")
        for _ in range(3):
            fppd.settings(pauseBackgroundEffects="1")
            wait_output(fppd, rx, lambda f: f[MODEL] == seq[0][MODEL], "the effect to pause")
            fppd.settings(pauseBackgroundEffects="0")
            wait_output(fppd, rx, lambda f: f[MODEL] == b"\xb0" * SIZE, "the effect to resume")


def bad_eseqs():
    good = eseq_bytes(solid(4, SIZE, 0x77), START)
    return {
        # 0d52af91c: a zero channel count divided by zero opening the file.
        # That traps on x86 and 32-bit ARM; aarch64 division by zero yields
        # 0, so on a Pi 5 this case passes either way.
        "zero channel count": b"ESEQ" + bytes([1, 0, 0, 0]) + bytes(4) + (11).to_bytes(4, "little") + bytes(4),
        "header only": good[:20],
        "cut inside the header": good[:12],
        # 768207cba: a model past the end of channel space; its clear range
        # zeroed memory past the channel buffer when the effect ended
        "model past the end of channel space": eseq_bytes(solid(4, SIZE, 0x77), 0x7FFFFFF0),
        "not an effect file": b"hello, world\n" * 4,
        "empty": b"",
    }


@pytest.mark.parametrize("what", list(bad_eseqs()))
def test_bad_effect_file_is_refused_or_survived(fppd, what):
    """A broken ESEQ file, started looping and then once through, neither
    takes fppd down nor leaves it unable to run a good effect afterwards.
    (Regressions: 0d52af91c, 768207cba.)"""
    write_eseq_raw = bad_eseqs()[what]
    fppd.write("effects/bad.eseq", write_eseq_raw)
    good = solid(20, SIZE, 0x77)
    write_eseq(fppd, "good", good, START)
    outputs_only(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect_start(fppd, "bad", loop=False)
        effect_start(fppd, "bad", loop=True)
        time.sleep(1)
        fppd.command("Effect Stop", "bad")
        time.sleep(0.3)
        effect_start(fppd, "good")
        wait_output(fppd, rx, lambda f: f[MODEL] == good[0], "a good effect after the bad one")
        fppd.command("Effects Stop")
        wait_output(fppd, rx, lambda f: not any(f), "the output to go dark")


def test_fseq_effect_starts_refused_at_the_limit_dont_leak_the_file(fppd):
    """With the most effects fppd will run (100) already running, every
    further FSEQ Effect Start is refused -- and leaves nothing open behind
    it: fppd holds the same number of descriptors on the sequence after
    fifty refused starts as before them.

    Regression: f39edf939. StartEffect owns the FSEQFile it is handed, but
    its "maximum number of effects already running" return didn't delete
    it, so each refused start leaked the file, its descriptor and its
    buffers -- and a caller retrying at the ceiling leaked one per try."""
    write_fseq(os.path.join(fppd.media, "sequences", "Glow.fseq"),
               unique_frames(20, CHANNELS), step_ms=50)
    outputs_only(fppd)
    fppd.start()

    def open_on_glow():
        fd_dir = f"/proc/{fppd.proc.pid}/fd"
        n = 0
        for fd in os.listdir(fd_dir):
            try:
                n += os.readlink(os.path.join(fd_dir, fd)).endswith("/Glow.fseq")
            except OSError:
                pass
        return n

    for _ in range(100):
        fppd.command("FSEQ Effect Start", "Glow", "true", "false", "false", "false")
    fppd.wait_for(lambda: len(running(fppd)) == 100, timeout=20, what="100 effects running")
    before = open_on_glow()
    assert before >= 100, f"only {before} descriptors on the sequence with 100 effects running"

    for _ in range(50):
        fppd.command("FSEQ Effect Start", "Glow", "true", "false", "false", "false")
    time.sleep(0.5)
    # The starts reached the limit check (not an earlier refusal).
    assert fppd.log().count("maximum number of effects already running") >= 50
    assert len(running(fppd)) == 100
    assert open_on_glow() == before, \
        f"{open_on_glow() - before} descriptors on the sequence leaked by 50 refused starts"
