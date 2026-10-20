"""Media commands driven through command presets (MEDIA_STARTED and
MEDIA_STOPPED) and their replies, heard on a PipeWire null sink."""

import os
import threading
import time

from audio import write_tone_wav
from show import playlist, status
from test_media_commands import slot_status, sounding_seconds


def preset(name, command, *args):
    return {"name": name, "command": command, "args": [str(a) for a in args], "presetSlot": 0}


def warnings(fppd):
    return [str(w) for w in fppd.get("/fppd/status").get("warnings", [])]


def test_media_started_preset_that_plays_media_is_not_rerun_inside_itself(fppd, audio):
    """A MEDIA_STARTED preset that runs Play Media (which fires MEDIA_STARTED
    again) runs once: the nested trigger is skipped with a warning, the
    media plays on its slot, and one Stop Media Slot silences it.

    Regression: a33f34338. The preset re-triggered itself from inside Play
    Media on the same thread without bound, stopping and starting a pipeline
    at every level: the request never came back (and a second chain on
    another thread used a freed stream)."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 5)
    fppd.write("config/commandPresets.json", {"commands": [
        preset("MEDIA_STARTED", "Play Media", "Tone.wav", 1, 0, 2)]})
    fppd.start()
    fppd.command("Play Media", "Tone.wav", "1", "0", "2", timeout=10)
    fppd.wait_for(lambda: any("triggers itself" in w for w in warnings(fppd)), timeout=5,
                  what="the self-trigger warning")
    fppd.wait_for(lambda: (slot_status(fppd, 2) or {}).get("status") == "playing", timeout=5,
                  what="slot 2 to play")
    fppd.command("Stop Media Slot", "2", timeout=10)
    time.sleep(0.5)
    rec = audio.record()
    time.sleep(1.5)
    heard = sounding_seconds(rec.stop())
    assert heard < 0.2, f"{heard:.2f} s still sounding after one Stop Media Slot"


def test_media_stopped_preset_that_stops_the_playlist_does_not_wedge(fppd, audio):
    """A MEDIA_STOPPED preset that stops the running playlist, fired when a
    Play Media file on slot 2 ends by itself, stops the playlist and leaves
    fppd answering: the slots can be listed and Play Media still plays.

    Regression: 94c26da88. The preset ran inline on the GStreamer streaming
    thread that delivered the end of stream. Stopping the playlist stops
    the background slots, and closing the slot-2 output waited for that
    output's bus handler -- the very call running the preset -- while
    holding the slot manager's lock, which every later media command then
    waited on for good."""
    from test_playlist_entries import pause
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 1)
    write_tone_wav(os.path.join(fppd.media, "music", "Next.wav"), 1.5, freq=600)
    fppd.write("playlists/P.json", playlist("P", [pause(60)]))
    fppd.write("config/commandPresets.json", {"commands": [preset("MEDIA_STOPPED", "Stop Now")]})
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10,
                  what="the playlist to play")
    fppd.command("Play Media", "Tone.wav", "1", "0", "2")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=6,
                  what="the MEDIA_STOPPED preset to stop the playlist")
    fppd.command("Media Slot Status", timeout=5)
    rec = audio.record()
    fppd.command("Play Media", "Next.wav", "1", "0", "2", timeout=5)
    time.sleep(2.2)
    heard = sounding_seconds(rec.stop())
    assert heard >= 0.8, f"Play Media after the preset played {heard:.2f} s of a 1.5 s file"


def test_stop_media_slot_on_a_playlists_media_says_it_was_asked(fppd, audio):
    """Stop Media Slot on a slot that holds a playlist's media answers
    "Stop requested for slot N": the command only asks the playlist to stop
    it, which happens on the playlist's next pass.

    Regression: 83fde8a45. It answered "Stopped slot N" whether or not it
    had stopped anything itself."""
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 10)
    fppd.write("playlists/P.json", playlist("P", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Song.wav"}]))
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10,
                  what="the playlist to play")
    time.sleep(1)
    r = fppd.command("Stop Media Slot", "1", timeout=10)
    assert str(r).startswith("Stop requested for slot 1"), r


def test_two_play_media_on_one_slot_at_once_leave_one_stream(fppd, audio):
    """Two Play Media commands for the same slot, sent at the same moment
    from two clients, leave one stream on it: a single Stop Media Slot then
    silences the slot, round after round.

    Regression: d6b5be023. Stopping what held the slot and starting the new
    stream were two steps; both requests found the slot empty and both
    started, and the slot tracked only the later stream, so the earlier one
    kept sounding where no command could stop it."""
    write_tone_wav(os.path.join(fppd.media, "music", "A.wav"), 10, freq=500)
    write_tone_wav(os.path.join(fppd.media, "music", "B.wav"), 10, freq=1500)
    fppd.start()
    for rnd in range(30):
        barrier = threading.Barrier(2)

        def play(name):
            barrier.wait()
            fppd.command("Play Media", name, "1", "0", "2", timeout=15)

        threads = [threading.Thread(target=play, args=(n,)) for n in ("A.wav", "B.wav")]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        time.sleep(0.3)
        fppd.command("Stop Media Slot", "2", timeout=10)
        time.sleep(0.4)
        rec = audio.record()
        time.sleep(0.5)
        heard = sounding_seconds(rec.stop())
        if heard >= 0.1:
            fppd.command("Stop All Media", timeout=10)
        assert heard < 0.1, f"round {rnd}: {heard:.2f} s still sounding after one Stop Media Slot"
