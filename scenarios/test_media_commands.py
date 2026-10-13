"""Media started by commands and by MultiSync, heard on a PipeWire null sink:
looping, odd file names, many commands at once, pause/resume, and a remote
told to play a file outside its media folder."""

import os
import random
import socket
import tempfile
import threading
import time

from audio import RATE, write_tone_wav
from fseq import unique_frames, write_fseq
from multisync import sync_packet
from show import CHANNELS, ddp_output, playlist, status

MULTISYNC_PORT = 32320


def sounding_seconds(samples, threshold=0.1, window_s=0.05):
    """How many seconds of the recording carry sound above threshold."""
    n = int(RATE * window_s)
    loud = sum(1 for i in range(0, len(samples) - n + 1, n)
               if max(abs(x) for x in samples[i:i + n]) > threshold)
    return loud * window_s


def first_sound(samples, threshold=0.1):
    """Seconds into the recording of the first sample above threshold."""
    for i, x in enumerate(samples):
        if abs(x) > threshold:
            return i / RATE
    return None


def test_play_media_loop_count_plays_every_pass(fppd, audio):
    """Play Media with a loop count of 3 plays a 1 s file three times, and
    Stop All Media still answers afterwards.

    Regression: 287b9dd7d. The loop seek was issued from the bus sync
    handler, on the streaming thread that had just posted EOS; the sink's
    flush re-took its own preroll lock and the seek never returned. The
    file played once, then silence, and the next stop wedged the main loop.
    """
    write_tone_wav(os.path.join(fppd.media, "music", "Loop.wav"), 1)
    fppd.start()
    rec = audio.record()
    fppd.command("Play Media", "Loop.wav", "3", "0", "1")
    time.sleep(4.5)
    samples = rec.stop()
    heard = sounding_seconds(samples)
    assert 2.6 <= heard <= 3.4, f"heard {heard:.2f} s of 3 passes of a 1 s file"
    fppd.command("Stop All Media", timeout=5)


def test_media_file_name_with_a_quote_plays(fppd, audio):
    """A media file whose name contains a double quote (the upload page
    keeps it, so '12" Mix.wav' is a real name) plays.

    Regression: 747cc3b75. The file name was pasted into a gst_parse_launch
    string inside quotes, so the quote ended the location early and the
    pipeline never built.
    """
    name = 'Twelve " Mix.wav'
    write_tone_wav(os.path.join(fppd.media, "music", name), 2)
    fppd.start()
    rec = audio.record()
    fppd.command("Play Media", name, "1", "0", "1")
    time.sleep(3.5)
    samples = rec.stop()
    heard = sounding_seconds(samples)
    assert heard >= 1.6, f"heard {heard:.2f} s of a 2 s file"


def test_media_commands_from_many_clients_at_once(fppd, audio):
    """Play, stop and slot commands for several slots, from four clients at
    once for 20 s, leave fppd answering and able to play again.

    Regression: 148857b14. Commands stopped and closed outputs they did not
    own, from HTTP threads, while the owning thread ran Process() on them and
    later deleted them: a double Close() unreffed the pipeline twice, and a
    stop raced the start thread raising a pipeline it had already taken down.
    """
    for k in range(3):
        write_tone_wav(os.path.join(fppd.media, "music", f"S{k}.wav"), 0.5 + k * 0.3,
                       freq=500 + 300 * k)
    fppd.start()
    stop_at = time.monotonic() + 20
    errors = []

    def client(seed):
        rnd = random.Random(seed)
        while time.monotonic() < stop_at:
            slot = str(rnd.randint(1, 3))
            choice = rnd.random()
            try:
                if choice < 0.45:
                    fppd.command("Play Media", f"S{rnd.randint(0, 2)}.wav",
                                 str(rnd.randint(1, 3)), "0", slot, timeout=15)
                elif choice < 0.65:
                    fppd.command("Stop Media Slot", slot, timeout=15)
                elif choice < 0.8:
                    fppd.command("Stop Media", f"S{rnd.randint(0, 2)}.wav", timeout=15)
                elif choice < 0.9:
                    fppd.command("Stop All Media", timeout=15)
                else:
                    fppd.command("Media Slot Status", timeout=15)
            except TimeoutError as e:
                errors.append(str(e))
                return
            except Exception:  # a refused command is fine; a wedge is not
                pass
            time.sleep(rnd.random() * 0.05)

    threads = [threading.Thread(target=client, args=(s,)) for s in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors[0]
    fppd.command("Stop All Media", timeout=10)
    time.sleep(0.5)
    rec = audio.record()
    fppd.command("Play Media", "S2.wav", "1", "0", "1", timeout=10)
    time.sleep(1.8)
    heard = sounding_seconds(rec.stop())
    assert heard >= 0.8, f"after the burst of commands a 1.1 s file played {heard:.2f} s"


def test_resumed_companion_media_rejoins_the_entry(fppd, audio):
    """A media entry with a companion on slot 2, interrupted by Insert
    Playlist Immediate and then resumed, brings the companion back at the
    entry's position, not from the start of its file.

    Regression: 587f5d11d. The resumed entry starts its companion with Play
    Media and seeks it to the entry's offset at once, while that pipeline is
    still starting, and the seek was dropped: the companion played from 0
    until the slot drift repair noticed, about 4 s later.
    """
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 30)
    write_tone_wav(os.path.join(fppd.media, "music", "Comp.wav"), 30, freq=600)
    write_tone_wav(os.path.join(fppd.media, "music", "Break.wav"), 1.5, freq=800)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Song.wav",
        "extraMediaName": "Comp.wav", "extraMediaSlot": 2}]))
    fppd.write("playlists/Break.json", playlist("Break", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Break.wav"}]))
    fppd.start()
    fppd.command("Start Playlist", "Song", "false", "false")
    fppd.wait_for(lambda: (slot_status(fppd, 2) or {}).get("status") == "playing",
                  timeout=10, what="the companion to start")
    time.sleep(6)
    fppd.command("Insert Playlist Immediate", "Break", "0", "0", "false")
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("mediaFilename") == "Break.wav",
                  timeout=5, what="the inserted playlist to play")
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("mediaFilename") == "Song.wav"
                  and (slot_status(fppd, 2) or {}).get("status") == "playing",
                  timeout=10, interval=0.1, what="the entry and its companion to resume")
    time.sleep(1.5)
    main, comp = slot_status(fppd, 1), slot_status(fppd, 2)
    gap = main["secondsElapsed"] - comp["secondsElapsed"]
    assert main["secondsElapsed"] >= 6, f"the entry itself started over: {main}"
    assert abs(gap) <= 1, f"companion at {comp['secondsElapsed']} s, entry at {main['secondsElapsed']} s"


def test_remote_refuses_media_outside_its_media_folder(fppd, audio):
    """A remote told by MultiSync to play an absolute path or a "../" path
    plays nothing, and a master's full path into its music folder plays the
    remote's own copy.

    Regression: 3e39e16c4. The file name in the sync packet was used as it
    came, so any host on the network could make a remote play (open) any
    file on its disk.
    """
    outside = tempfile.mkdtemp(prefix="outside-")
    write_tone_wav(os.path.join(outside, "Outside.wav"), 3)
    write_tone_wav(os.path.join(fppd.media, "music", "Inside.wav"), 3)
    fppd.settings(fppMode="remote")
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def play(name, seconds=2.5):
        rec = audio.record()
        sock.sendto(sync_packet("open", "media", 0, 0, name), ("127.0.0.1", MULTISYNC_PORT))
        sock.sendto(sync_packet("start", "media", 0, 0, name), ("127.0.0.1", MULTISYNC_PORT))
        began = time.monotonic()
        while time.monotonic() - began < seconds:
            el = time.monotonic() - began
            sock.sendto(sync_packet("sync", "media", 0, el, name), ("127.0.0.1", MULTISYNC_PORT))
            time.sleep(0.25)
        sock.sendto(sync_packet("stop", "media", 0, seconds, name), ("127.0.0.1", MULTISYNC_PORT))
        time.sleep(0.5)
        return sounding_seconds(rec.stop())

    relative = os.path.relpath(os.path.join(outside, "Outside.wav"),
                               os.path.join(fppd.media, "music"))
    for name in (os.path.join(outside, "Outside.wav"), relative):
        heard = play(name)
        assert heard < 0.2, f"the remote played {name!r} ({heard:.2f} s)"
    heard = play("/home/fpp/media/music/Inside.wav")
    assert heard >= 1.0, f"a master's full path to music/Inside.wav played {heard:.2f} s"


def slot_status(fppd, slot):
    for s in fppd.command("Media Slot Status", timeout=5):
        if s.get("slot") == slot:
            return s
    return None


def play_and_check_status(fppd, slot):
    write_tone_wav(os.path.join(fppd.media, "music", f"Slot{slot}.wav"), 6)
    fppd.command("Play Media", f"Slot{slot}.wav", "1", "0", str(slot))
    time.sleep(3)
    s = slot_status(fppd, slot)
    assert s and s.get("status") == "playing", f"slot {slot}: {s}"
    assert 2 <= s.get("secondsElapsed", -1) <= 4, f"slot {slot} 3 s in reports {s}"
    fppd.command("Stop Media Slot", str(slot))


def test_play_media_status_moves_with_the_player_idle(fppd, audio):
    """With no playlist running, Media Slot Status follows a Play Media
    file's position on slot 2.

    Regression: 3428bcfbb. Play Media's outputs were pumped only from a
    playing playlist's tick, so with the player idle their status sat at 0
    for the whole track (and the watchdogs that run from the same pump never
    ran).
    """
    fppd.start()
    play_and_check_status(fppd, 2)


def test_play_media_on_slot_1_reports_its_own_position(fppd, audio):
    """Media Slot Status follows a Play Media file's position on slot 1.

    Regression: b654f988a. Play Media on slot 1 keeps its own status (so as
    not to overwrite the playlist's), but the listing read slot 1 from the
    playlist's global status and showed 0 for the whole track.
    """
    fppd.start()
    play_and_check_status(fppd, 1)


def test_media_on_another_slot_does_not_pace_the_show(fppd, audio):
    """A Play Media loop on slot 2, started seconds before a sequence+media
    entry on slot 1, leaves the sequence's frames in order with no more than
    the odd skip or hold.

    Regression: f55e99c8c. Every media output fed its position to the
    channel output servo, so the show's media and the other slot's took turns
    and each pass yanked the frames toward whichever reported last: held for
    one, skipped ahead for the other.
    """
    from ddp import DdpReceiver
    from frames import analyze
    secs = 12
    frames = unique_frames(secs * 20, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), secs)
    write_tone_wav(os.path.join(fppd.media, "music", "Other.wav"), 30, freq=400)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Song.fseq", "mediaName": "Song.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Play Media", "Other.wav", "1", "0", "2")
        time.sleep(4)
        fppd.command("Start Playlist", "Song", "false", "false")
        time.sleep(secs + 2)
        received = rx.snapshot()
    r = analyze(frames, received)
    print(r.summary())
    assert r.unknown == 0 and r.backwards == 0, r.summary()
    # Following its own media, the show repeats or skips the odd frame; two
    # clocks 4 s apart pulling at it is dozens.
    assert r.dropped + r.repeats <= 12, r.summary()


def test_random_media_picks_only_media_files(fppd, audio):
    """Six random-audio entries over a music folder that also holds text
    files and subfolders play the one audio file six times.

    Regression: 9c8ee3ffe. Random mode listed every entry of the folder,
    directories and non-media files included, and a pick that landed on one
    failed to play (eleven picks in twelve here).
    """
    music = os.path.join(fppd.media, "music")
    write_tone_wav(os.path.join(music, "Tone.wav"), 0.6)
    # One audio file among eleven things that aren't: before the fix nearly
    # every pick missed it.
    for k in range(8):
        with open(os.path.join(music, f"notes{k}.txt"), "w") as f:
            f.write("not media\n")
    for k in range(3):
        os.makedirs(os.path.join(music, f"Sub{k}"))
    entry = {"type": "media", "enabled": 1, "playOnce": 0, "fileMode": "randomAudio"}
    fppd.write("playlists/Random.json", playlist("Random", [dict(entry) for _ in range(6)]))
    fppd.start()
    rec = audio.record()
    fppd.command("Start Playlist", "Random", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10,
                  what="the playlist to start")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30,
                  what="the playlist to finish")
    heard = sounding_seconds(rec.stop())
    assert heard >= 3.0, f"heard {heard:.2f} s of six 0.6 s random picks"
