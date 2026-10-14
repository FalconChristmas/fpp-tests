"""Sequence names from playlists are flat file names in the sequences
directory, and nothing else. (Sync packets are checked before this, as they
arrive: test_multisync_packets.)"""

import os
import time

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, install, playlist, sequence_entry
from test_playback import wait_idle

STEP_MS = 50


def run_entry(fppd, name, rx):
    """Play a one-entry playlist naming `name`; return what was sent."""
    fppd.write("playlists/Odd.json", playlist("Odd", [sequence_entry(name)]))
    since = time.monotonic()
    try:
        fppd.command("Start Playlist", "Odd", "false", "false")
    except Exception:
        pass
    time.sleep(3)
    try:
        fppd.command("Stop Now")
    except Exception:
        pass
    wait_idle(fppd, timeout=10)
    return [d for t, d in rx.snapshot(since=since) if any(d)]


def test_a_name_outside_the_sequences_directory_is_refused(fppd):
    """A playlist entry naming ../music/<file> doesn't play that file, though
    it is a valid sequence.

    Regression: 976ab9dd7. Names weren't checked, so ../ reached any file --
    and checkForReplacementFile()'s unlink/rename on the way out."""
    frames = unique_frames(100, CHANNELS)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        os.makedirs(os.path.join(fppd.media, "music"), exist_ok=True)
        write_fseq(os.path.join(fppd.media, "music", "Outside.fseq"), frames, step_ms=STEP_MS)
        fppd.start()
        lit = run_entry(fppd, "../music/Outside.fseq", rx)
    assert not lit, f"{len(lit)} frames of a sequence outside the sequences directory played"


def test_an_overlong_name_is_refused(fppd):
    """A sequence name longer than a path can be is refused, not copied
    into a fixed buffer.

    Regression: 976ab9dd7. strcpy() into a 2048-byte stack buffer."""
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, unique_frames(20, CHANNELS), step_ms=STEP_MS)
        fppd.start()
        run_entry(fppd, "x" * 2100 + ".fseq", rx)
        since = time.monotonic()
        fppd.command("Start Playlist", "Show", "false", "false")
        wait_idle(fppd, timeout=15)
        assert rx.count(since=since) > 10, "the player didn't play afterwards"

