"""A MultiSync remote playing its own copy of the show's media keeps it with
the master.

This script is the master: open, start, then a media sync every half second
(as GStreamerOut sends them) with positions on the monotonic clock. The
remote's sound is timed burst by burst off its card's sink (bursts.py)
against when the master's timeline puts each burst.

Only meaningful against a real card -- the remote steers its sound onto the
master's clock, and against a null sink that runs on a VM timer there is
nothing steady to steer to -- so these run with run-local.sh --host-audio
(FPP_TESTS_HOST_AUDIO); FPP_TESTS_REMOTE_SECONDS sets the length (default
120). Bursts are judged from 20 s in: a remote starting after the master
first seeks to it, then slews the rest.
"""

import os
import re
import shutil
import socket
import statistics
import subprocess
import time

import pytest

from bursts import StreamRecorder, burst_tone, card_ppm, card_status, offsets_against
from multisync import PORT, sync_packet

# The remote's resync seek (GStreamerOut::AdjustFeedSpeed, LogInfo): each one
# is an audible dropout.
RESYNC_SEEK = re.compile(r"GStreamer feed sync: [+-]?\d+ ms from the master .*seeking to")


def _remote_follows(fppd, audio, master_name, settle_s=20, delay=None, seen=None):
    """Play as the master for the remote set up in fppd; the remote's sound
    against the master's timeline, ms, per burst from settle_s on.

    delay(k) -> seconds to hold back the k-th media sync (1-based): it goes
    out that late still carrying the position it was due with, as a packet
    the network held does. seen, a dict, gets seeks_before_late: the resync
    seeks fppd had logged when the first held-back packet went out."""
    secs = int(os.environ.get("FPP_TESTS_REMOTE_SECONDS", "120"))
    rec = StreamRecorder(audio.card_sink)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))
    statuses = []
    try:
        fppd.start()
        time.sleep(2)
        send("open", "media", 0, 0.0, master_name)
        time.sleep(1)
        send("start", "media", 0, 0.0, master_name)
        t0 = time.monotonic()
        nxt = t0 + 0.5
        k = 0
        held = None  # (send at, position it was due with)
        while time.monotonic() < t0 + secs:
            now = time.monotonic()
            if held and now >= held[0]:
                send("sync", "media", 0, held[1], master_name)
                held = None
            if now >= nxt:
                k += 1
                hold = delay(k) if delay else 0.0
                if hold > 0:
                    if seen is not None and "seeks_before_late" not in seen:
                        seen["seeks_before_late"] = len(RESYNC_SEEK.findall(fppd.log()))
                    held = (nxt + hold, nxt - t0)
                else:
                    send("sync", "media", 0, now - t0, master_name)
                nxt += 0.5
                st = card_status()
                if st:
                    statuses.append(st)
                fppd.check_alive()
            time.sleep(0.01)
        send("stop", "media", 0, 0.0, master_name)
        time.sleep(2)
    finally:
        rec.stop()
        sock.close()
    offs = offsets_against(rec.burst_times(card_ppm(statuses)), t0, int((secs - 1) // 2))
    print(f"\nremote sound minus master, ms, every 5th burst: {[round(o) for _, o in offs[::5]]}")
    late = [o for k, o in offs if 1 + 2 * k >= settle_s]
    assert len(late) >= (secs - settle_s) // 2 - 2, f"only {len(late)} bursts heard after {settle_s} s"
    print(f"from {settle_s} s: median {statistics.median(late):+.1f}, min {min(late):+.1f}, max {max(late):+.1f} ms")
    return late


def test_remote_audio_follows_the_master(fppd, audio):
    """A remote's own copy of the show audio plays within 50 ms of the
    master's timeline, and holds there.

    Regression: 71fd2d8a4. AdjustSpeed() corrected with GStreamer rate
    changes, which the persistent output stream can't play: it runs at the
    card's rate, so a sped-up feed only queued audio where nothing saw it.
    The remote settled 0.4-0.6 s behind the master (and mp3/FLAC refuse an
    instant rate change outright, so every correction was a flushing seek).
    Now the feed's speed is steered and resampled to the card's rate.

    Verified with run-local.sh --host-audio on a Pi 5 I2S HAT: +114 ms
    median (+111..+127) on 73f7fd82d, -1.4 ms (-3..+1) on 71fd2d8a4; an mp3
    on the parent settled +0.4-0.6 s behind. (A wav: an mp3 from GStreamer's
    lamemp3enc has no LAME header and plays 25 ms late by itself.)"""
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    burst_tone(os.path.join(fppd.media, "music", "Song.wav"),
               int(os.environ.get("FPP_TESTS_REMOTE_SECONDS", "120")) + 5)
    fppd.settings(fppMode="remote")
    late = _remote_follows(fppd, audio, "Song.wav")
    assert max(abs(o) for o in late) <= 50, f"the remote's sound strayed {max(abs(o) for o in late):.0f} ms from the master"
    assert max(late) - min(late) <= 30, f"the remote's sound wandered {max(late) - min(late):.0f} ms"


def test_remote_audio_rides_out_late_packets(fppd, audio):
    """Sync packets that arrive late don't make a remote's audio seek: with
    one media sync in twenty (every 10 s, from 30 s) held back 100 ms -- what
    a 2.4 GHz Wi-Fi link does to some of them -- the remote makes no resync
    seek after the first late packet, and its sound stays within 50 ms of the
    master's.

    Regression: 7f573e2d3. AdjustFeedSpeed() steered by every packet as it
    arrived. A late one carries a position the master has moved past, so it
    read as the remote ~100 ms ahead, past the 50 ms seek threshold: the
    seek pulled the sound back by the delay, the landing taught the next
    seek to aim that much further ahead, and each late packet cost two or
    three audible seeks (22 in one five-minute song on a Pi 5 remote on
    2.4 GHz Wi-Fi). Now it decides on the lowest reading of the last two
    seconds, the rule MasterFrame0() steers a remote's lights by
    (d9b8f5d3b).

    Needs a real card: run-local.sh --host-audio, on each side of the fix
    (verify-fix.sh builds in Docker, which has none). Verified with
    run-local.sh --host-audio on a Pi 5 with an I2S DAC, optimized builds:
    on the parent, 04ee4931e, 27 resync seeks after the late packets began,
    three per late packet, and the sound settled ~100 ms ahead of the
    master; on 7f573e2d3, no seek, -3..+8 ms (2 of 2). (Also on a Pi 5
    with a USB card against 10.3: 27 seeks without the fix, a pass with
    it.)"""
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    secs = int(os.environ.get("FPP_TESTS_REMOTE_SECONDS", "120"))
    assert secs >= 60, "FPP_TESTS_REMOTE_SECONDS must leave room for late packets after 30 s"
    burst_tone(os.path.join(fppd.media, "music", "Song.wav"), secs + 5)
    # The seeks are counted from their LogInfo line: below info, none would be.
    fppd.settings(fppMode="remote", LogLevel_MediaOut="info")
    seen = {}
    late = _remote_follows(fppd, audio, "Song.wav", seen=seen,
                           delay=lambda k: 0.1 if k >= 50 and k % 20 == 0 else 0.0)
    assert "seeks_before_late" in seen, "no late packet was sent"
    seeks = len(RESYNC_SEEK.findall(fppd.log())) - seen["seeks_before_late"]
    assert seeks == 0, f"{seeks} resync seeks after the late packets began (each an audible dropout)"
    assert max(abs(o) for o in late) <= 50, f"the remote's sound strayed {max(abs(o) for o in late):.0f} ms from the master"
    assert max(late) - min(late) <= 30, f"the remote's sound wandered {max(late) - min(late):.0f} ms"


def test_remote_video_sound_follows_the_master(fppd, audio):
    """A remote showing a video for the master's audio file (the projector
    setup: master plays Song.mp3, remote has videos/Song.mp4) plays the
    video's sound within 50 ms of the master.

    Regression: 35d0909f9. The video's sound went to a pipewiresink of its
    own on the system clock; each rate change the remote made queued sound
    there, and it ended up ~180 ms behind the master and drifting. Now it
    feeds the slot's output stream and is steered with the picture.

    Needs a connected display: FPP_TESTS_VIDEO_OUT names the connector
    (e.g. HDMI-A-2), and ffmpeg to make the video. Verified with run-local.sh
    --host-audio on a Pi 5 I2S HAT with HDMI: +183 ms median (+181..+196)
    on 71fd2d8a4, -6 ms (-8..-3) on 35d0909f9."""
    connector = os.environ.get("FPP_TESTS_VIDEO_OUT")
    if not os.environ.get("FPP_TESTS_HOST_AUDIO") or not connector:
        pytest.skip("needs a real sound card and a display: run-local.sh --host-audio, FPP_TESTS_VIDEO_OUT")
    if not shutil.which("ffmpeg"):
        pytest.skip("needs ffmpeg to make the video")
    secs = int(os.environ.get("FPP_TESTS_REMOTE_SECONDS", "120")) + 5
    wav = os.path.join(fppd.media, "tmp", "burst.wav")
    burst_tone(wav, secs)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30",
                    "-i", wav, "-t", str(secs), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                    "-g", "30", "-c:a", "aac", "-shortest", os.path.join(fppd.media, "videos", "Song.mp4")],
                   check=True)
    fppd.settings(fppMode="remote", VideoOutput=connector)
    late = _remote_follows(fppd, audio, "Song.mp3")
    assert max(abs(o) for o in late) <= 50, f"the video's sound strayed {max(abs(o) for o in late):.0f} ms from the master"
    assert max(late) - min(late) <= 30, f"the video's sound wandered {max(late) - min(late):.0f} ms"


def test_a_remote_moves_to_the_masters_next_file_on_a_sync_packet(fppd, audio):
    """A remote playing A.wav that gets a media sync for B.wav -- the
    master has moved on and the open packet was lost -- opens B.wav and
    plays it, with no "Error starting media" warning.

    Regression: 84f4ee28b (OpenMediaOutput). With media already open,
    OpenMediaOutput() unlocked mediaOutputLock to close it and then
    unlocked it again; the second unlock threw std::system_error, which
    was caught and reported as "Error starting media B.wav: Operation not
    permitted": that sync was lost, and B.wav opened only on the next one,
    with an error on the banner. Runs in Docker against the null sink (the
    audio fixture)."""
    from audio import write_tone_wav
    for name in ("A.wav", "B.wav"):
        write_tone_wav(os.path.join(fppd.media, "music", name), 30)
    fppd.settings(fppMode="remote")
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))

    def started(name):
        return re.search(r"GStreamer started playing: \S*/music/" + re.escape(name) + "$",
                         fppd.log(), re.M)
    try:
        time.sleep(2)
        send("open", "media", 0, 0.0, "A.wav")
        send("start", "media", 0, 0.0, "A.wav")
        fppd.wait_for(lambda: started("A.wav"), timeout=15, interval=0.25, what="A.wav to play")
        for t in (1.0, 1.5, 2.0, 2.5):
            send("sync", "media", 0, t, "B.wav")
            time.sleep(0.5)
        fppd.wait_for(lambda: started("B.wav"), timeout=15, interval=0.25,
                      what="B.wav to replace A.wav")
        errors = [w for w in fppd.get("/fppd/status").get("warnings", []) if "starting media" in w]
        assert not errors, errors
        assert "System exception starting media" not in fppd.log()
        send("stop", "media", 0, 0.0, "B.wav")
    finally:
        sock.close()


# AdjustFeedSpeed()'s seek line parsed: error, local, master, target.
RESYNC_SEEK_AT = re.compile(r"GStreamer feed sync: ([+-]?\d+) ms from the master "
                            r"\(([\d.]+) vs ([\d.]+)\), seeking to ([\d.]+)")
# Its LogDebug once a seek has landed: what the next seek will aim ahead.
RESYNC_AIM = re.compile(r"GStreamer feed sync: resync landed [+-][\d.]+ ms from the master; "
                        r"seeks now aim (\d+) ms ahead")


def test_a_bad_seek_landing_doesnt_leave_a_remote_seeking(fppd, audio):
    """Seeks that landed late on one song don't leave a remote seeking every
    two seconds through the next: after A.wav has taught the remote to aim
    its seeks as far ahead as it will, B.wav, joined 3 s late, takes at most
    three resync seeks in 40 s.

    Issue #3156, fixed by fpp 87da41c21. On a video remote an accurate seek decodes from the
    previous keyframe, so with keyframes seconds apart it can take 1-3 s to
    resume; AdjustFeedSpeed() reads that as a landing behind and aims the
    next seek further ahead. The aim (s_feedResyncLeadS) is static, so it
    carries into every later song, and a landing a second or more off is
    never learnt from, so once the aim is ~1.5 s each seek lands ~1.5 s
    ahead and seeks again, every 2-2.5 s until fppd restarts (8,110 seeks
    in four nights in the reporter's diagnostic report, three quarters of
    them over a second ahead with the aim at 1.6-2.0 s).

    Here the slow seeks are stood in for on audio, so it runs in Docker
    against the null sink: while each of A.wav's seeks settles, this master
    jumps ahead by that seek's aim plus 0.6 s, so each lands ~0.6 s behind
    and the aim grows by ~0.5 s, until it is over 1.2 s or stops growing
    (a cap) at 0.9 s or more. B.wav then plays on a steady master, the
    remote starting 3 s behind it."""
    from audio import write_tone_wav
    for name in ("A.wav", "B.wav"):
        write_tone_wav(os.path.join(fppd.media, "music", name), 90)
    # The aim is only logged at debug.
    fppd.settings(fppMode="remote", LogLevel_MediaOut="debug")
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))

    def play(name, secs, offset=0.0, on_tick=None):
        """Master `name` for `secs`, positions `offset` ahead of the clock
        plus whatever on_tick(now) returns (None ends it early)."""
        send("open", "media", 0, 0.0, name)
        send("start", "media", 0, 0.0, name)
        t0 = time.monotonic()
        nxt = t0 + 0.5
        while time.monotonic() < t0 + secs:
            now = time.monotonic()
            if now >= nxt:
                extra = on_tick(now) if on_tick else 0.0
                if extra is None:
                    break
                send("sync", "media", 0, now - t0 + offset + extra, name)
                nxt += 0.5
                fppd.check_alive()
            time.sleep(0.01)
        send("stop", "media", 0, 0.0, name)
        time.sleep(2)

    jump = {"shift": 0.0, "seen": 0, "at": None, "by": 0.0}

    def slow_seeks(now):
        log = fppd.log()
        aims = [int(a) for a in RESYNC_AIM.findall(log)]
        if aims and (aims[-1] >= 1200 or (len(aims) >= 2 and aims[-1] == aims[-2] >= 900)):
            return None  # taught as far as it goes (a capped aim stops growing): on to B.wav
        seeks = RESYNC_SEEK_AT.findall(log)
        if len(seeks) > jump["seen"]:
            jump["seen"] = len(seeks)
            _, _, master, target = seeks[-1]
            # Inside the seek's 2 s settle, so its landing reads behind.
            jump["at"], jump["by"] = now + 0.5, float(target) - float(master) + 0.6
        if jump["at"] and now >= jump["at"]:
            jump["shift"] += jump["by"]
            jump["at"] = None
        return jump["shift"]

    try:
        time.sleep(2)
        play("A.wav", 60, offset=1.0, on_tick=slow_seeks)  # a first seek to build on
        aims = [int(a) for a in RESYNC_AIM.findall(fppd.log())]
        print(f"\nA.wav: seeks aimed {aims} ms ahead")
        assert aims and aims[-1] >= 900, \
            f"A.wav never taught the remote an aim near a second ({aims}): the test, not fppd, needs a look"
        before = len(RESYNC_SEEK.findall(fppd.log()))
        play("B.wav", 40, offset=3.0)
        seeks = RESYNC_SEEK_AT.findall(fppd.log())[before:]
        print(f"B.wav: {len(seeks)} resync seeks, errors ms {[int(s[0]) for s in seeks]}")
        assert len(seeks) <= 3, \
            f"B.wav took {len(seeks)} resync seeks in 40 s (each a dropout): the aim A.wav left kept them landing off"
    finally:
        sock.close()



def write_six_channel_wav(path, tone_s, seconds, rate=48000):
    """A 6-channel WAV, a 440 Hz tone on its front pair for the first
    tone_s seconds and silence after: more channels than the slot's
    persistent output stream carries, so it plays to a pipewiresink of
    its own."""
    import array
    import math
    import wave
    pcm = array.array("h", bytes(2 * 6 * int(seconds * rate)))
    tone = array.array("h", (int(3000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(int(tone_s * rate))))
    pcm[0:6 * len(tone):6] = tone
    pcm[1:6 * len(tone):6] = tone
    with wave.open(path, "wb") as w:
        w.setnchannels(6)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def test_a_remote_with_its_own_sink_keeps_up_with_a_fast_master(fppd, audio):
    """A remote plays a 6-channel file -- a pipewiresink of its own, not the
    slot's persistent output stream -- for a master whose media syncs run 3%
    fast. It speeds up to follow: from 30 s to 40 s it stays within 250 ms
    of the master and loses no more ground (its offset moves by at most
    60 ms), and the 41 s of tone at the head of the file is heard over no
    more than 40.4 s of the null sink (the master gets through it in
    39.8 s; played at 1x it takes 41).

    Regression: 11de6c82c. AdjustSpeed() (7471f0a6c) changed only the
    pipeline's rate, which a pipewiresink drained by PipeWire at the
    graph's rate never plays: the media went on at 1x, 1.2 s behind at
    30 s and 1.5 s at 40 s, while the requested rate climbed past 1.2. Now
    the stream's adapter resamples at the rate, and the pipeline's clock
    runs at it so the sink keeps the stream fed. (A stereo or mono file
    plays through the persistent output stream, which AdjustFeedSpeed()
    steers instead -- see above. 3% is far beyond any card's drift, but the
    null sink's VM timer leaves nothing finer to measure in Docker; at 3%,
    AdjustSpeed()'s 2% rate steps settle 100-150 ms behind.)"""
    from audio import RATE
    from test_media_commands import slot_status
    write_six_channel_wav(os.path.join(fppd.media, "music", "Six.wav"), 41, 50)
    fppd.settings(fppMode="remote")
    fppd.start()
    rec = audio.record()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))
    fast = 1.03
    offsets = []
    try:
        send("open", "media", 0, 0.0, "Six.wav")
        time.sleep(1)
        send("start", "media", 0, 0.0, "Six.wav")
        t0 = time.monotonic()
        nxt = t0 + 0.5
        while time.monotonic() < t0 + 44:
            now = time.monotonic()
            if now >= nxt:
                send("sync", "media", 0, (now - t0) * fast, "Six.wav")
                nxt += 0.5
                if 30 <= now - t0 <= 40:
                    sl = slot_status(fppd, 1) or {}
                    if sl.get("status") == "playing":
                        local = sl["secondsElapsed"] + sl["subSecondsElapsed"] / 100
                        offsets.append(round((local - (time.monotonic() - t0) * fast) * 1000))
            time.sleep(0.01)
        send("stop", "media", 0, 0.0, "Six.wav")
    finally:
        sock.close()
    samples = rec.stop()
    n = RATE // 100
    loud = [i for i in range(0, len(samples) - n + 1, n) if max(map(abs, samples[i:i + n])) > 0.02]
    heard_s = (loud[-1] - loud[0]) / RATE if loud else 0.0
    assert len(offsets) >= 15, f"the remote wasn't playing: {offsets}"
    # Unsteered, the remote loses 30 ms a second: 300 ms over these 10 s.
    assert max(abs(o) for o in offsets) <= 250 and max(offsets) - min(offsets) <= 60, \
        f"remote minus master, ms, from 30 s: {offsets}"
    assert 38 <= heard_s <= 40.4, f"41 s of tone took {heard_s:.2f} s to play"
