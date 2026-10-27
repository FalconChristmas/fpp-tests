"""What a MultiSync master tells its remotes about the media it plays: which
file the media syncs name, and how soon a stop goes out. fppd plays into
the audio fixture's null sink; its packets to a remote address are seen off
the loopback interface (capture.py)."""

import os
import time

from audio import write_tone_wav
from capture import UdpCapture
from multisync import PORT, parse_sync
from show import playlist, status
from test_media_commands import slot_status

REMOTE = "127.0.0.2"


def media_syncs(packets):
    return [s for s in (parse_sync(t, p) for t, _, _, p in packets)
            if s and s.file_type == "media"]


def test_companion_media_is_not_synced_as_the_show(fppd, audio):
    """A media entry with a companion on slot 2 plays on a MultiSync master;
    every media packet the master sends names the entry's own file, never
    the companion's.

    Regression: 7f433c79e. Every slot's GStreamerOutput sent media syncs, so
    the companion broadcast itself as the master's media, its position
    alternating with the song's, and remotes that have no companion support
    switched their media to it."""
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 20)
    write_tone_wav(os.path.join(fppd.media, "music", "Comp.wav"), 20, freq=600)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Song.wav",
        "extraMediaName": "Comp.wav", "extraMediaSlot": 2}]))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE)
    with UdpCapture(PORT, REMOTE) as cap:
        fppd.start()
        fppd.command("Start Playlist", "Song", "false", "false")
        fppd.wait_for(lambda: (slot_status(fppd, 2) or {}).get("status") == "playing",
                      timeout=10, what="the companion to start")
        time.sleep(4)
        syncs = media_syncs(cap.snapshot())
    fppd.command("Stop Now")
    assert any(s.action == "sync" for s in syncs), "precondition: no media syncs sent at all"
    names = sorted({s.filename for s in syncs})
    assert names == ["Song.wav"], f"media packets named {names}"


def test_media_stop_goes_out_before_the_teardown(fppd, audio):
    """A MultiSync master playing a media playlist is told Stop Now: the
    media stop packet leaves within 150 ms, ahead of the media's pipeline
    teardown (three rounds). With a second file playing on slot 2, Stop Now
    stops that too.

    Regression: 3a794f4eb. StopNow() stopped every stream slot, slot 1
    included, before the entry's own Stop(), which is what sends the media
    stop; so the packet waited out slot 1's whole teardown (its silence
    flush) and remotes stopped about half a second after the master."""
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 30)
    write_tone_wav(os.path.join(fppd.media, "music", "Bg.wav"), 30, freq=600)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Song.wav"}]))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE)

    def start_song():
        fppd.command("Start Playlist", "Song", "false", "false")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="the song")

    def stop_packet_after(cap, t0):
        fppd.wait_for(lambda: any(s.action == "stop" and s.time >= t0
                                  for s in media_syncs(cap.snapshot())),
                      timeout=5, what="the media stop packet")
        return min(s.time for s in media_syncs(cap.snapshot()) if s.action == "stop" and s.time >= t0)

    delays = []
    with UdpCapture(PORT, REMOTE) as cap:
        fppd.start()
        for _ in range(3):
            start_song()
            time.sleep(2)
            t0 = time.monotonic()
            fppd.command("Stop Now", timeout=10)
            done = time.monotonic()
            delays.append((round((stop_packet_after(cap, t0) - t0) * 1000), round((done - t0) * 1000)))
            fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", what="idle")
        start_song()
        fppd.command("Play Media", "Bg.wav", "1", "0", "2", timeout=10)
        fppd.wait_for(lambda: (slot_status(fppd, 2) or {}).get("status") == "playing",
                      timeout=10, what="slot 2 to play")
        fppd.command("Stop Now", timeout=10)
        fppd.wait_for(lambda: (slot_status(fppd, 2) or {}).get("status") != "playing",
                      timeout=5, what="slot 2 to stop with the playlist")
    # (ms to the stop packet, ms for Stop Now to return) per round
    assert all(d[0] <= 150 for d in delays), f"media stop packet late: {delays}"

