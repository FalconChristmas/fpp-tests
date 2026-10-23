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

    Also covers 6d944fcdb: the entry's own media, restarted at the paused
    offset, sought before decodebin had linked and played from 0.
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
    ran). 9ac5b7233 had pumped slots 2-5 from a playing playlist; before it
    nothing pumped them at all.
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


def test_random_media_plays_a_mixed_case_extension(fppd, audio):
    """Three random-audio entries over a music folder whose one file is
    "Tone.Wav" play it three times.

    Regression: 0098170ef. The media-only filter from 9c8ee3ffe checked the
    raw extension against tables holding only the all-lower and all-upper
    spellings, so a folder ripped as *.Mp3 raised "No media files found to
    play in 'randomAudio' mode" and played nothing.
    """
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.Wav"), 0.6)
    entry = {"type": "media", "enabled": 1, "playOnce": 0, "fileMode": "randomAudio"}
    fppd.write("playlists/Random.json", playlist("Random", [dict(entry) for _ in range(3)]))
    fppd.start()
    rec = audio.record()
    fppd.command("Start Playlist", "Random", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30,
                  what="the playlist to finish")
    heard = sounding_seconds(rec.stop())
    warnings = status(fppd).get("warnings", [])
    assert not any("No media files found" in w for w in warnings), warnings
    assert heard >= 1.2, f"heard {heard:.2f} s of three 0.6 s random picks"


def test_remote_finds_its_own_video_for_the_masters_audio(fppd, audio):
    """A remote told by MultiSync to play Song.mp3, which it doesn't have,
    plays its own per-host video for it, videos/Song-<HostName>.mkv.

    Regression: 680451806. The per-host path was built from "videos/Song."
    less two characters, so it looked for Son-<host>.mkv, found nothing, and
    the remote played nothing."""
    from test_video import make_video
    make_video(os.path.join(fppd.media, "videos", "Song-box1.mkv"), seconds=6)
    fppd.settings(fppMode="remote", HostName="box1", LogLevel_MediaOut="debug")
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rec = audio.record()
    name = "Song.mp3"
    sock.sendto(sync_packet("open", "media", 0, 0, name), ("127.0.0.1", MULTISYNC_PORT))
    sock.sendto(sync_packet("start", "media", 0, 0, name), ("127.0.0.1", MULTISYNC_PORT))
    began = time.monotonic()
    while time.monotonic() - began < 3:
        sock.sendto(sync_packet("sync", "media", 0, time.monotonic() - began, name),
                    ("127.0.0.1", MULTISYNC_PORT))
        time.sleep(0.25)
    heard = sounding_seconds(rec.stop(), threshold=0.03)
    sock.sendto(sync_packet("stop", "media", 0, 3, name), ("127.0.0.1", MULTISYNC_PORT))
    assert "remote will try Song-box1.mkv" in fppd.log(), \
        "the remote did not pick its per-host video for Song.mp3"
    assert heard >= 1.0, f"the remote's video for Song.mp3 played {heard:.2f} s of sound"


def test_wled_audio_sync_follows_one_slot(fppd, audio):
    """WLED audio sync in send mode, with a 440 Hz tone on slot 1 and a
    louder 1 kHz one on slot 2: the packets' major peak follows slot 1.

    Regression: 1b9fa77b8. Every playing slot's sample tap wrote the one
    ring the WLED analysis reads, so the two streams interleaved in it and
    the peak landed near neither (the commit measured 764 Hz).

    Feature: bd1ca1cfb (the WLED sample tap), 228a7c2c4 (a second slot
    plays beside the first)."""
    import struct
    from udp import Listener
    from test_video import free_udp_port
    port = free_udp_port()
    write_tone_wav(os.path.join(fppd.media, "music", "A440.wav"), 8, freq=440, amplitude=0.3)
    write_tone_wav(os.path.join(fppd.media, "music", "B1000.wav"), 8, freq=1000, amplitude=0.9)
    fppd.settings(WLEDAudioSyncMode="send", WLEDAudioSyncDest="127.0.0.1", WLEDAudioSyncPort=str(port))
    rx = Listener(port)
    try:
        fppd.start()
        fppd.command("Play Media", "A440.wav", "1", "0", "1")
        time.sleep(0.5)
        fppd.command("Play Media", "B1000.wav", "1", "0", "2")
        time.sleep(1.5)
        since = time.monotonic()
        time.sleep(3)
        with rx.lock:
            got = [d for t, d in rx.packets if t >= since and len(d) == 44]
    finally:
        rx.close()
    assert len(got) > 50, f"only {len(got)} audio-sync packets in 3 s"
    peaks = [struct.unpack_from("<f", d, 40)[0] for d in got]
    near = sum(1 for p in peaks if abs(p - 445) <= 50)
    assert near >= 0.9 * len(peaks), \
        f"{near} of {len(peaks)} major peaks near 440 Hz; some: {[round(p) for p in peaks[::max(1, len(peaks) // 15)]]}"


def write_noise_then_bursts_mp3(path, noise_s=15, total_s=30):
    """A VBR MP3 with no table of contents: white noise for noise_s (dense
    frames), then silence with a 50 ms 1 kHz burst on each whole second
    (sparse frames). A seek estimated from the bitrate lands far from the
    time it asked for."""
    import array
    import math
    import subprocess
    import wave
    import pytest
    rnd = random.Random(7)
    pcm = array.array("h", bytes(2 * RATE * total_s))
    for i in range(RATE * noise_s):
        pcm[i] = int(rnd.uniform(-0.5, 0.5) * 32767)
    for k in range(noise_s + 1, total_s):
        for i in range(k * RATE, k * RATE + RATE // 20):
            pcm[i] = int(0.3 * 32767 * math.sin(2 * math.pi * 1000 * i / RATE))
    if array.array("h", [1]).tobytes() != b"\x01\x00":
        pcm.byteswap()
    wav = path + ".wav"
    with wave.open(wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    r = subprocess.run(["gst-launch-1.0", "-q", "filesrc", f"location={wav}", "!", "wavparse", "!",
                        "audioconvert", "!", "lamemp3enc", "target=quality", "quality=2", "!",
                        "filesink", f"location={path}"], capture_output=True, text=True, timeout=120)
    os.unlink(wav)
    if r.returncode:
        pytest.skip(f"cannot make a test MP3 (lamemp3enc): {r.stderr.strip()[-300:]}")


def test_a_resumed_vbr_mp3_comes_back_where_it_left_off(fppd, audio):
    """A VBR MP3 entry (no table of contents) interrupted by Insert
    Playlist Immediate 20 s in, in its quiet second half, resumes there:
    after the break come the once-a-second bursts, and none of the noise of
    its first 15 s.

    Regression: 755ca659b. The resume seek was KEY_UNIT, which in an MP3
    with no table of contents lands at a byte offset estimated from the
    bitrate while the position reads as asked, so the sound comes back away
    from the entry's position. Estimated from this file's dense first half,
    20 s lay past its end: the resumed entry ended at once, and nothing
    more played."""
    from audio import rms_windows
    write_noise_then_bursts_mp3(os.path.join(fppd.media, "music", "Song.mp3"))
    write_tone_wav(os.path.join(fppd.media, "music", "Break.wav"), 1.5, freq=800, amplitude=0.3)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Song.mp3"}]))
    fppd.write("playlists/Break.json", playlist("Break", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Break.wav"}]))
    fppd.start()
    fppd.command("Start Playlist", "Song", "false", "false")
    fppd.wait_for(lambda: ((slot_status(fppd, 1) or {}).get("secondsElapsed") or 0) >= 20,
                  timeout=30, interval=0.1, what="the entry to be 20 s in")
    fppd.command("Insert Playlist Immediate", "Break", "0", "0", "false")
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("mediaFilename") == "Break.wav",
                  timeout=5, interval=0.05, what="the inserted playlist to play")
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("mediaFilename") == "Song.mp3",
                  timeout=10, interval=0.05, what="the entry to resume")
    rec = audio.record()
    time.sleep(6)
    samples = rec.stop()
    noisy = [round(t, 1) for t, r in rms_windows(samples, 0.5) if r > 0.15]
    assert not noisy, f"the resumed entry played its noise (from {noisy[0]} s after the resume)"
    bursts, quiet = 0, 0
    for x in samples:
        if abs(x) > 0.1 and quiet > RATE * 0.5:
            bursts += 1
        quiet = 0 if abs(x) > 0.1 else quiet + 1
    assert bursts >= 4, f"heard {bursts} bursts in the 6 s after the resume"


def test_command_media_freed_while_its_slot_is_still_called(fppd, audio):
    """Play Media of a 0.3 s file on slot 1, 40 times over, each left to end
    by itself, while three clients keep sending Set Slot Volume for slot 1:
    fppd stays clean (no race, no memory error) and the media still plays
    afterwards.

    Regression: 0d21c6e70. A Play Media output that has ended is freed on
    the main loop a moment later, but it stayed in slot 1's table until
    ~GStreamerOutput's Close(), after GStreamerPlayData's members were
    already destroyed and its vtable gone. The slot manager's calls into it
    from the HTTP threads (SetVolume(), RequestStop()) went on reaching it
    all that time: under TSan, a race between the virtual call and the
    destructor's vtable switch. Shown red on master with the fix's Close()
    taken out: the fix's parent shows the same race, but its TSan run is red
    either way, from races later commits fixed.

    Each play is left to end by itself, and the next starts only once the
    slot is idle, so that no HTTP thread stops an output while another sets
    its volume: that is a race of its own on master (PROBLEMS.md #26).
    """
    write_tone_wav(os.path.join(fppd.media, "music", "Blip.wav"), 0.3)
    write_tone_wav(os.path.join(fppd.media, "music", "After.wav"), 1.2)
    fppd.start()
    done = threading.Event()
    errors = []
    calls = [0]

    def hammer(seed):
        rnd = random.Random(seed)
        while not done.is_set():
            try:
                fppd.command("Set Slot Volume", "1", str(rnd.randint(40, 90)), timeout=15)
            except TimeoutError as e:
                errors.append(str(e))
                return
            except Exception:  # refused while the slot is idle (before 6f875034b)
                pass
            calls[0] += 1

    def idle():
        s = slot_status(fppd, 1)
        return s and s.get("status") == "idle"

    threads = [threading.Thread(target=hammer, args=(s,)) for s in range(3)]
    for t in threads:
        t.start()
    try:
        for _ in range(40):
            fppd.command("Play Media", "Blip.wav", "1", "0", "1", timeout=15)
            fppd.wait_for(idle, timeout=10, interval=0.02, what="the 0.3 s play to end")
    finally:
        done.set()
        for t in threads:
            t.join()
    assert not errors, errors[0]
    assert calls[0] >= 200, f"only {calls[0]} volume calls during the 40 plays"
    rec = audio.record()
    fppd.command("Play Media", "After.wav", "1", "0", "1", timeout=10)
    time.sleep(2)
    heard = sounding_seconds(rec.stop())
    assert heard >= 0.8, f"after the plays a 1.2 s file played {heard:.2f} s"
