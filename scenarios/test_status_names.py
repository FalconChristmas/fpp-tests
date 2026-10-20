"""What /fppd/status says is playing: a sequence started on its own, a
playlist made on the fly from a file, a sequence+media playlist entry, and
a remote's prepared sequence after a rejected request. The header badge and
the MultiSync page read these fields."""

import os
import time

from fseq import unique_frames, write_fseq
from multisync import PORT, sync_packet
from show import CHANNELS, ddp_output, playlist, sequence_entry, status
from test_command_socket import send
from test_playlist_media import both, song


def test_lone_sequence_is_reported_playing(fppd):
    """A sequence started outside a playlist (the UI's sequence Play button
    goes through the command socket's StartSequence) shows as status_name
    "playing" with current_sequence naming it, while the player's own
    status stays idle (0) for the scheduler.

    Regression: f733f1551. The sequence engine runs it without the player,
    so status_name read "idle" with current_sequence empty while channel
    data was visibly playing."""
    write_fseq(os.path.join(fppd.media, "sequences", "Solo.fseq"), unique_frames(400, 30))
    fppd.start()
    send("StartSequence,Solo.fseq,0")
    s = fppd.wait_for(lambda: (lambda s: s if s.get("current_sequence") == "Solo.fseq" else None)(
        status(fppd)), timeout=10, what="the sequence to show in the status")
    assert s.get("status_name") == "playing", s.get("status_name")
    assert int(s.get("status")) == 0, s.get("status")
    send("StopSequence")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                  what="the sequence to stop")


def test_playlist_made_from_a_file_is_marked_generated(fppd):
    """Start Playlist with a sequence file's name plays a one-entry playlist
    made on the fly, and the status marks it current_playlist.generated; a
    saved playlist is not marked.

    Feature: f733f1551 (current_playlist.generated, so the UI can tell "Play
    on a file" from a saved playlist)."""
    write_fseq(os.path.join(fppd.media, "sequences", "Solo.fseq"), unique_frames(400, 30))
    fppd.write("playlists/Saved.json", playlist("Saved", [sequence_entry("Solo.fseq")]))
    fppd.start()
    for name, generated in (("Solo.fseq", True), ("Saved", False)):
        fppd.command("Start Playlist", name, "false", "false")
        s = fppd.wait_for(lambda: (lambda s: s if s.get("status_name") == "playing" else None)(
            status(fppd)), timeout=10, what=f"{name} to play")
        assert s["current_playlist"].get("generated") is generated, (name, s["current_playlist"])
        fppd.command("Stop Now")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                      what=f"{name} to stop")


def test_song_entry_is_reported_as_its_sequence(fppd, audio):
    """While a playlist's sequence+media entry plays, status_name stays
    "playing" and current_sequence names its sequence.

    Regression: 6ffff35d6. The playlist's own media plays on stream slot 1,
    and the slot summary overwrote the player's status: "playing media",
    with the sequence's name hidden from the MultiSync page."""
    song(fppd, 6)
    fppd.write("playlists/Song.json", playlist("Song", [both("Song.fseq", "Song.wav")]))
    fppd.start()
    fppd.command("Start Playlist", "Song", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("type") == "both",
                  timeout=10, what="the song entry")
    fppd.wait_for(lambda: status(fppd).get("media_playing"), timeout=10, what="the media")
    for _ in range(6):
        s = status(fppd)
        assert s.get("status_name") == "playing", s.get("status_name")
        assert s.get("current_sequence") == "Song.fseq", s.get("current_sequence")
        time.sleep(0.25)
    fppd.command("Stop Now")


def test_rejected_name_does_not_strand_a_prepared_sequence(fppd):
    """A remote with a sequence opened by its master but not yet started
    still starts it -- SEQUENCE_STARTED runs, once -- after a request for a
    sequence with a ../ name arrives in between.

    Regression: aefc9fb9e. Rejecting the name cleared the "starting" flag of
    the sequence already open, so it read as running without ever having
    been started: the status said "playing", nothing started it (the
    request's own start, and then the master's start, both saw a sequence
    already running), and SEQUENCE_STARTED never ran."""
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), unique_frames(400, CHANNELS))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/commandPresets.json", {"commands": [
        {"name": "SEQUENCE_STARTED", "command": "Set Variable",
         "args": ["started", "Increment", "", "1", "0", "100", ""], "presetSlot": 0}]})
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    fppd.start()

    def started():
        v = (fppd.get("/variables") or {}).get("started", {}).get("value")
        return int(float(v)) if v not in (None, "") else 0

    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.sendto(sync_packet("open", "fseq", 0, 0, "Show.fseq"), ("127.0.0.1", PORT))
        time.sleep(1)
        assert status(fppd).get("status_name") == "idle", "an opened sequence read as playing"
        # The command socket checks only that nothing is running, which a
        # prepared sequence isn't, so the name reaches the open.
        send("StartSequence,../Missing.fseq,0")
        time.sleep(1)
        sock.sendto(sync_packet("start", "fseq", 0, 0, "Show.fseq"), ("127.0.0.1", PORT))
        fppd.wait_for(started, timeout=5, what="SEQUENCE_STARTED for the prepared sequence")
        time.sleep(1)
        assert started() == 1, f"SEQUENCE_STARTED ran {started()} times"
        sock.sendto(sync_packet("stop", "fseq", 0, 0, "Show.fseq"), ("127.0.0.1", PORT))
    finally:
        sock.close()
