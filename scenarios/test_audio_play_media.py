"""Media through the PipeWire backend, heard on the audio fixture's null
sink: what the status says about media outside a playlist, what a media
start logs, a slot played twice, the persistent output stream kept open or
closed, and a sequence held back until its media sounds."""

import os
import signal
import subprocess
import time

from audio import write_tone_wav
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist, status
from test_media_commands import slot_status, sounding_seconds


def graph_nodes(audio):
    return subprocess.run(["pw-cli", "ls", "Node"], env=audio.env, capture_output=True,
                          text=True).stdout


def test_media_outside_a_playlist_is_reported_in_the_status(fppd, audio):
    """Play Media with no playlist running: /fppd/status says "playing
    media" for slot 1 and "playing background" for a slot above it, with
    current_song naming the file, while the player's own numeric status
    stays idle; it reads "idle" again once the media is stopped.

    Feature: 115e9661b. status_name read "idle" while a track was audibly
    playing on a slot."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 20)
    fppd.start()
    for slot, name in ((1, "playing media"), (3, "playing background")):
        fppd.command("Play Media", "Tone.wav", "1", "0", str(slot))
        s = fppd.wait_for(lambda: (lambda s: s if s.get("status_name") == name else None)(status(fppd)),
                          timeout=10, what=f"status_name {name!r} for slot {slot}")
        assert s.get("current_song") == "Tone.wav", s.get("current_song")
        assert s.get("status") == 0, f"the player's numeric status moved: {s.get('status')}"
        fppd.command("Stop All Media")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                      what="idle after the media stopped")


def test_a_media_start_logs_nothing_about_a_missing_slot_volume_file(fppd, audio):
    """Media starting on a slot with no pipewire-stream-slots.json (the
    normal case: it is written only once a slot fader has moved) plays,
    and fppd logs nothing about the missing file.

    Regression: 19ad65a19. Every slot start read the file through
    LoadJsonFromFile(), which logs a missing file at error level: one
    spurious error per media item."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 1)
    fppd.start()
    for slot in (1, 2):
        fppd.command("Play Media", "Tone.wav", "1", "0", str(slot))
        fppd.wait_for(lambda: (slot_status(fppd, slot) or {}).get("status") == "playing",
                      timeout=10, what=f"slot {slot} to play")
        fppd.wait_for(lambda: (slot_status(fppd, slot) or {}).get("status") != "playing",
                      timeout=10, what=f"slot {slot} to finish")
    lines = [l for l in fppd.log().splitlines() if "pipewire-stream-slots.json" in l]
    assert not lines, f"a missing slot volume file was logged: {lines[:3]}"


def test_play_media_again_on_a_slot_replaces_what_it_played(fppd, audio):
    """A second Play Media on a slot that is still playing stops the first
    file: the slot then holds the second, and one Stop Media Slot leaves
    nothing sounding.

    Regression: 27360cd92. The second Play Media built another pipeline
    on the slot and left the first running; the slot tracked only the
    newer stream, so the first kept sounding where no command could stop
    it (and the first's teardown could clear the newer stream's slot)."""
    write_tone_wav(os.path.join(fppd.media, "music", "A.wav"), 15, freq=500)
    write_tone_wav(os.path.join(fppd.media, "music", "B.wav"), 15, freq=1500)
    fppd.start()
    for rnd in range(3):
        fppd.command("Play Media", "A.wav", "1", "0", "2", timeout=15)
        time.sleep(1.5)
        fppd.command("Play Media", "B.wav", "1", "0", "2", timeout=15)
        time.sleep(1.5)
        s = slot_status(fppd, 2) or {}
        assert s.get("status") == "playing" and s.get("mediaFilename", "").endswith("B.wav"), \
            f"round {rnd}: slot 2 after the second Play Media: {s}"
        fppd.command("Stop Media Slot", "2", timeout=10)
        time.sleep(0.6)
        rec = audio.record()
        time.sleep(0.6)
        heard = sounding_seconds(rec.stop())
        if heard >= 0.1:
            fppd.command("Stop All Media", timeout=10)
        assert heard < 0.1, f"round {rnd}: {heard:.2f} s still sounding after Stop Media Slot"


def test_keep_audio_output_open(fppd, audio):
    """PipeWireKeepOutputOpen=1 opens slot 1's output stream (the
    fppd_stream_1 node) with nothing played and keeps it while idle.

    Feature: 5a1b5092d."""
    fppd.settings(PipeWireKeepOutputOpen="1")
    fppd.start()
    fppd.wait_for(lambda: "fppd_stream_1" in graph_nodes(audio), timeout=15,
                  what="slot 1's output stream with nothing played")
    time.sleep(12)
    assert "fppd_stream_1" in graph_nodes(audio), "the kept-open output stream closed while idle"


def test_output_stream_closes_after_the_track_when_not_kept_open(fppd, audio):
    """With PipeWireKeepOutputOpen unset, slot 1's output stream is not
    there with nothing played, comes up for a track, and closes a few
    seconds (the linger) after it.

    Feature: e4533d96d (the persistent output stream), 5a1b5092d (its
    linger when not kept open)."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 1)
    fppd.start()
    time.sleep(3)
    assert "fppd_stream_1" not in graph_nodes(audio), "an output stream opened with nothing to play"
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    fppd.wait_for(lambda: "fppd_stream_1" in graph_nodes(audio), timeout=10,
                  what="slot 1's output stream for the track")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                  what="the track to end")
    fppd.wait_for(lambda: "fppd_stream_1" not in graph_nodes(audio), timeout=15, interval=0.5,
                  what="the output stream to close after the linger")


def test_the_lights_wait_for_the_sound_to_start(fppd, audio):
    """A sequence+media entry starts its sequence once the media is
    audible, not when the entry starts: with the PipeWire daemon stopped
    for 1.5 s across the start, no frame of the sequence goes out before
    the daemon runs again (the entry's fallback is 4 s). The sequence's
    first frame may go out as the entry is prepared; it is the frames after
    it, the sequence running, that must wait.

    Regression: e4533d96d. The sequence and the media started together, so
    the lights ran ahead of the sound by however long the audio output
    took to come up -- most of a second on a slow board -- and caught up
    only as the sync servo slowed them."""
    secs = 6
    frames = unique_frames(secs * 20, CHANNELS)
    running = set(frames[2:])
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), secs)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Song.fseq", "mediaName": "Song.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    daemon = audio.procs[0]
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        os.kill(daemon.pid, signal.SIGSTOP)
        try:
            t0 = time.monotonic()
            fppd.command("Start Playlist", "Song", "false", "false", timeout=20)
            time.sleep(max(0.0, t0 + 1.5 - time.monotonic()))
            resumed = time.monotonic()
        finally:
            os.kill(daemon.pid, signal.SIGCONT)
        fppd.wait_for(lambda: any(d[:CHANNELS] in running for _, d in rx.snapshot()), timeout=10,
                      what="the sequence to run")
        first = min(t for t, d in rx.snapshot() if d[:CHANNELS] in running)
    lead = resumed - first
    assert lead <= 0.1, \
        f"the sequence ran {first - t0:.2f} s after the start, {lead:.2f} s before the audio could run"
