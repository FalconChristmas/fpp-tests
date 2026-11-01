"""What a MultiSync master puts in the seconds field of a sequence sync."""

import os
import time

from audio import write_tone_wav
from capture import UdpCapture
from fseq import unique_frames, write_fseq
from multisync import PORT, parse_sync
from show import CHANNELS, ddp_output, playlist, status

REMOTE = "127.0.0.2"
STEP_MS = 50


def test_sequence_sync_seconds_are_the_sequences_not_the_medias(fppd, audio):
    """A master plays a sequence with its song, the song offset by 1.5 s:
    each sequence sync names a frame and the seconds of that frame
    (frame / refresh rate), not the song's position, which is the offset
    ahead of it.

    Regression: a4ebd7e23. The sync sent the media's elapsed seconds
    whenever there were any, so a remote that read the seconds field
    (a plugin, or an older player) saw the song's clock against the
    sequence's frame; here they differ by the whole offset."""
    write_fseq(f"{fppd.media}/sequences/Song.fseq", unique_frames(400, CHANNELS), step_ms=STEP_MS)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 20)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "both", "enabled": 1, "playOnce": 0, "sequenceName": "Song.fseq", "mediaName": "Song.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", MultiSyncEnabled="1", MultiSyncRemotes=REMOTE,
                  mediaOffset="1500")
    with UdpCapture(PORT, REMOTE) as cap:
        fppd.start()
        fppd.command("Start Playlist", "Song", "false", "false")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="the song")
        time.sleep(6)
        syncs = [s for s in (parse_sync(t, p) for t, _, _, p in cap.snapshot())
                 if s and s.file_type == "fseq" and s.action == "sync"]
    fppd.command("Stop Now")
    later = [s for s in syncs if s.frame > 0]
    assert len(later) >= 3, f"precondition: only {len(later)} sequence syncs past frame 0"
    off = [(s.frame, round(s.seconds, 2)) for s in later
           if abs(s.seconds - s.frame * STEP_MS / 1000.0) > 0.1]
    assert not off, f"sequence syncs whose seconds are not frame/rate: {off[:5]}"
