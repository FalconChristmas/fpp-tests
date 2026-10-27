"""A remote following a master whose sequence it doesn't have, or has a
shorter copy of, and the SEQUENCE_STARTED / SEQUENCE_STOPPED presets that
show what it did.

The presets count (Set Variable, Increment), so each scenario can check they
pair up: one start and one stop per sequence that actually played, none for
one that never did.
"""

import socket
import time

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from multisync import PORT, sync_packet
from show import CHANNELS, ddp_output, status

STEP_MS = 50


def counter(name):
    return {"name": name, "command": "Set Variable",
            "args": [name, "Increment", "", "1", "0", "100", ""], "presetSlot": 0}


def variable(fppd, name):
    v = (fppd.get("/variables", timeout=5) or {}).get(name, {}).get("value")
    return int(float(v)) if v not in (None, "") else 0


class Master:
    """Sends what a master playing `name` would: open, start, a sync every
    half second with the frame its clock is on, stop."""

    def __init__(self, name="Show.fseq"):
        self.name = name
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.began = None

    def send(self, action, frame=0):
        self.sock.sendto(sync_packet(action, "fseq", frame, frame * STEP_MS / 1000, self.name),
                         ("127.0.0.1", PORT))

    def frame(self):
        return round((time.monotonic() - self.began) * 1000 / STEP_MS)

    def play(self, seconds):
        self.send("open")
        time.sleep(0.5)
        self.send("start")
        self.began = time.monotonic()
        self.keep_playing(seconds)

    def keep_playing(self, seconds):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            time.sleep(0.5)
            self.send("sync", self.frame())

    def close(self):
        self.sock.close()


def remote(fppd, **settings):
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/commandPresets.json",
               {"commands": [counter("SEQUENCE_STARTED"), counter("SEQUENCE_STOPPED")]})
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote", **settings)


def presets(fppd):
    time.sleep(1)  # they run from the main loop
    return variable(fppd, "SEQUENCE_STARTED"), variable(fppd, "SEQUENCE_STOPPED")


def test_missing_sequence_fires_no_presets(fppd):
    """A remote without the master's sequence plays nothing, so neither
    preset fires -- however many sync packets arrive.

    Regression: 6dd1179f6. SEQUENCE_STARTED was queued on every sync packet
    whether or not anything started: several times a second for the whole
    song, with no SEQUENCE_STOPPED to match."""
    remote(fppd)
    m = Master("Missing.fseq")
    fppd.start()
    m.play(4)
    m.send("stop")
    assert presets(fppd) == (0, 0)
    m.close()


def test_shorter_copy_ends_once(fppd):
    """A remote whose copy of the sequence is shorter than the master's
    plays it to its end and goes dark, and the master's later sync packets
    don't reopen it: one start, one stop.

    Regression: 6dd1179f6. Each later sync reopened the file at a frame past
    its end, which closed it again -- a SEQUENCE_STOPPED per packet until the
    master stopped. (A zstd file, so the frame past the end also goes through
    the compressed reader's block search, de6d01998.)"""
    frames = unique_frames(40, CHANNELS)
    write_fseq(f"{fppd.media}/sequences/Show.fseq", frames, step_ms=STEP_MS, compression="zstd")
    remote(fppd)
    m = Master()
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        m.play(6)
        late = rx.snapshot(since=m.began + 3.5)
        m.send("stop")
        started, stopped = presets(fppd)
    m.close()
    assert (started, stopped) == (1, 1), f"SEQUENCE_STARTED x{started}, SEQUENCE_STOPPED x{stopped}"
    assert not any(any(d) for t, d in late), "the remote lit up again after its sequence ended"


def test_stale_sync_from_the_last_play_through_does_not_end_the_next(fppd):
    """When the master plays the same file twice in a row, a late copy of the
    first play-through's last sync packet can arrive after the second has
    started (two network paths to the remote, Wi-Fi holding multicast).  It
    jumps the remote to the end of the file; the master's next sync packets
    bring it back in step.

    Regression: 1f851f6a9. The remote ended the file within a second, then
    ignored every sync packet for it until the master's next open: dark for
    the rest of the play-through."""
    frames = unique_frames(600, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(f"{fppd.media}/sequences/Show.fseq", frames, step_ms=STEP_MS)
    remote(fppd)
    m = Master()
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        m.play(2)
        m.send("sync", len(frames) - 8)  # the late copy from the last play-through
        m.keep_playing(5)
        at = m.frame()
        recent = [lookup.get(d) for t, d in rx.snapshot(since=time.monotonic() - 0.5)]
        recent = [i for i in recent if i is not None]
        m.send("stop")
    m.close()
    assert recent and abs(recent[-1] - at) <= 6, \
        f"remote showing frame {recent[-1] if recent else None} with the master at {at}"


def test_stale_sync_does_not_carry_across_the_reopen_behind_it(fppd):
    """The same late path that delivers the last play-through's final sync
    packet then delivers its own copies of the master's stop, open and start,
    right behind it.  The reopen puts the remote back at the master's frame,
    so it never shows the end of the file.

    Regression: ed5a82164. The sync packet left a skip of most of the file
    pending, and the output thread applied it after the reopen, counting from
    frame 0: the remote jumped to the end of the new play-through and played
    out the file."""
    frames = unique_frames(600, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    end = len(frames) - 2000 // STEP_MS  # the last two seconds
    write_fseq(f"{fppd.media}/sequences/Show.fseq", frames, step_ms=STEP_MS)
    remote(fppd)
    m = Master()
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        for _ in range(3):
            m.send("open")
            time.sleep(0.5)
            m.send("start")
            m.began = time.monotonic()
            time.sleep(0.25)
            burst = time.monotonic()
            m.send("sync", len(frames) - 8)  # the late path: the last sync, then the reopen
            m.send("stop")
            m.send("open")
            m.send("start")
            m.keep_playing(3)
            shown = [lookup.get(d) for t, d in rx.snapshot(since=burst)]
            shown = [i for i in shown if i is not None]
            at = m.frame()
            m.send("stop")
            assert not [i for i in shown if i >= end], \
                f"remote showed frames {min(i for i in shown if i >= end)}+ of {len(frames)} after the reopen"
            assert shown and abs(shown[-1] - at) <= 6, \
                f"remote showing frame {shown[-1] if shown else None} with the master at {at}"
            time.sleep(0.5)
    m.close()


def test_fallback_follows_the_master_and_stops_with_it(fppd):
    """A remote without the master's sequence plays fallback.fseq instead,
    in step with the master's frame numbers, and stops when the master
    does.

    Regression: 1f945d9fd. Sync packets carry the master's file name, which
    never matched "fallback.fseq": the fallback froze two seconds in, and
    the stop packet didn't stop it."""
    frames = unique_frames(600, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(f"{fppd.media}/sequences/fallback.fseq", frames, step_ms=STEP_MS)
    remote(fppd)
    m = Master("Missing.fseq")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        m.play(6)
        at = m.frame()
        recent = [lookup.get(d) for t, d in rx.snapshot(since=time.monotonic() - 0.5)]
        recent = [i for i in recent if i is not None]
        m.send("stop")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                      what="the remote to stop with the master")
        time.sleep(0.5)
        dark = not any(rx.last())
    m.close()
    assert recent and abs(recent[-1] - at) <= 6, \
        f"fallback showing frame {recent[-1] if recent else None} with the master at {at}"
    assert dark, "the fallback's output was left lit after the master stopped"


def test_opened_but_never_started_fires_no_stop(fppd):
    """A sequence the master opened and then stopped without starting never
    played, so it fires neither preset.

    Regression: eee0321f5. SEQUENCE_STOPPED fired whenever an open file was
    closed, started or not."""
    write_fseq(f"{fppd.media}/sequences/Show.fseq", unique_frames(100, CHANNELS), step_ms=STEP_MS)
    remote(fppd)
    m = Master()
    fppd.start()
    m.send("open")
    time.sleep(1.5)
    m.send("stop")
    assert presets(fppd) == (0, 0)
    m.close()
