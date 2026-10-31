"""Fixes from the 7.0 and 8.0 releases that are reachable in fppd."""

import os
import time

from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output
from test_playlist_entries import playlist, status


def test_playing_sequence_reports_milliseconds_elapsed(fppd):
    """The current playlist entry of a playing sequence says how far in it is
    to the millisecond, in /api/player/current.

    Regression: dc635bb74. Entries gave whole seconds only, too coarse for a
    client following a sequence."""
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"),
               unique_frames(20 * 6, CHANNELS))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.write("playlists/P.json", playlist("P", main=[
        {"type": "sequence", "enabled": 1, "playOnce": 0, "sequenceName": "Song.fseq"}]))
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing")
    time.sleep(1.3)
    cur = fppd.get("/player/current")
    entry = cur["playlist"]["currentEntry"]
    assert entry.get("millisecondsElapsed", 0) >= 1000, entry
    assert entry["millisecondsElapsed"] < 5000, entry
    fppd.command("Stop Now")
