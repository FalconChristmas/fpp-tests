"""Media outputs being started, paused, stopped and torn down while the rest
of fppd -- status on the HTTP threads, the playlist on the main loop,
commands on their own threads -- reads and drives them.

Most of these are races or lock-order bugs. A lost race under ASan is a
use-after-free; the unsynchronized accesses behind them show under TSan
(run.sh --flavor tsan) even when the two sides don't overlap in time, and a
lock-order bug is a wedge: a request that never answers.
"""

import os
import threading
import time

from audio import write_tone_wav
from show import playlist, status


def media_entry(name):
    return {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": name}


def poll(fppd, stop, errors, path="/fppd/status"):
    try:
        while not stop.is_set():
            fppd.get(path, timeout=10)
    except Exception as e:  # noqa: BLE001 -- reported by the caller
        errors.append(e)


def test_status_polled_while_a_song_plays_pauses_and_resumes(fppd, audio):
    """A playlist song paused and resumed three times while status is
    polled from three threads: every poll answers and the song plays on.

    Regression: 2cff29f44. The media status fields (elapsed, remaining,
    totals) were written by the output's owner -- setMediaElapsed() on the
    main loop, the reset and the resume's restore on a command thread -- and
    read for status on the HTTP threads with no lock between them (TSan: data
    race between MediaOutputBase::setMediaElapsed and GetCurrentFPPDStatus /
    StreamSlotManager::GetAllSlotsStatus)."""
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 30)
    fppd.write("playlists/Song.json", playlist("Song", [media_entry("Song.wav")]))
    fppd.start()
    fppd.command("Start Playlist", "Song", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="the song to play")
    stop = threading.Event()
    errors = []
    pollers = [threading.Thread(target=poll, args=(fppd, stop, errors)) for _ in range(3)]
    for t in pollers:
        t.start()
    try:
        time.sleep(1.5)
        for _ in range(3):
            fppd.command("Pause Playlist")
            fppd.wait_for(lambda: status(fppd).get("status_name") == "paused", what="paused")
            time.sleep(0.5)
            fppd.command("Resume Playlist")
            fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing again")
            time.sleep(1.5)
    finally:
        stop.set()
        for t in pollers:
            t.join(20)
    assert not errors, errors[0]
    assert status(fppd).get("current_song") == "Song.wav"


def test_a_slot_volume_set_while_a_silent_video_prerolls(fppd, audio):
    """A video with no audio track played five times on a slot with a
    saved volume, Set Slot Volume sent while each plays: every one plays
    and every command answers.

    Regression: ce238f804. A slot's saved volume is applied while the
    pipeline is still prerolling, which is when no-more-pads fires for a
    file with no sound and OnNoMorePads() removes the audio chain on a
    streaming thread, dropping (and freeing) the volume element.
    SetVolume() read m_volume with no lock (TSan: data race between
    GStreamerOutput::SetVolume and GStreamerOutput::OnNoMorePads; a
    g_object_set() on a freed element when they meet)."""
    from test_video import make_video, overlay_consumer, setup
    make_video(os.path.join(fppd.media, "videos", "Silent.mkv"), seconds=2, audio=False)
    setup(fppd, [overlay_consumer()])
    fppd.write("config/pipewire-stream-slots.json", {"slots": {"1": 80}})
    fppd.start()
    for i in range(5):
        fppd.command("Play Media", "Silent.mkv", "1", "0", "1", "HDMI-A-1")
        for v in (60, 70):
            fppd.command("Set Slot Volume", "1", str(v + i))
            time.sleep(0.2)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15,
                      interval=0.2, what=f"video {i + 1} to end")


def test_a_remotes_next_file_does_not_report_the_last_ones_position(fppd, audio):
    """A remote plays A.wav for five seconds, then the master moves on to
    B.wav, whose pipeline is held before it prerolls (med_holdread.c): until
    B.wav reports a position of its own, status gives it 0 s elapsed, not
    A.wav's five.

    Regression: 31ba68bf3. mediaOutputStatus is shared by every media
    output and only Process() writes its elapsed fields, so until the new
    pipeline produced a position they still described the previous file:
    status showed B.wav five seconds in, and the first sync packet's
    AdjustSpeed() took that stale position for a 5 s drift and issued a
    flushing seek into the unprerolled pipeline (issue #2727)."""
    import socket

    import shims
    from multisync import PORT, sync_packet
    for name in ("A.wav", "B.wav"):
        write_tone_wav(os.path.join(fppd.media, "music", name), 30)
    tmp = os.path.join(fppd.media, "tmp")
    arm, mark, release = (os.path.join(tmp, n) for n in ("arm", "mark", "release"))
    fppd.settings(fppMode="remote")
    fppd.start(preload=[shims.build("med_holdread.c")],
               extra_env={"HOLDREAD_NAME": "/B.wav", "HOLDREAD_ARM": arm,
                          "HOLDREAD_MARK": mark, "HOLDREAD_RELEASE": release})
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))
    try:
        time.sleep(2)
        send("open", "media", 0, 0.0, "A.wav")
        send("start", "media", 0, 0.0, "A.wav")
        began = time.monotonic()
        while time.monotonic() - began < 5.5:
            send("sync", "media", 0, time.monotonic() - began, "A.wav")
            time.sleep(0.5)
        s = status(fppd)
        assert s.get("media_filename") == "A.wav" and int(s["seconds_elapsed"]) >= 4, s
        open(arm, "w").close()
        send("stop", "media", 0, time.monotonic() - began, "A.wav")
        send("open", "media", 0, 0.0, "B.wav")
        send("start", "media", 0, 0.0, "B.wav")
        fppd.wait_for(lambda: os.path.exists(mark), timeout=15, interval=0.1,
                      what="B.wav's pipeline to reach the held read")
        seen = []
        for _ in range(10):
            s = status(fppd)
            seen.append((s.get("media_filename"), s.get("seconds_elapsed"), s.get("seconds_remaining")))
            time.sleep(0.1)
        stale = [x for x in seen if x[0] == "B.wav" and int(x[1]) >= 2]
        assert not stale, f"B.wav reported A.wav's position before playing: {seen}"
        assert any(x[0] == "B.wav" for x in seen), f"the remote never reported B.wav: {seen}"
    finally:
        open(release, "w").close()
        send("stop", "media", 0, 0.0, "B.wav")
        sock.close()


def logged_at(fppd, pattern):
    """When fppd first logged a line matching `pattern`, as seconds of the day."""
    import re
    m = re.search(r"^\S+ (\d+):(\d+):([\d.]+) .*" + pattern, fppd.log(), re.M)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None


def started_at(fppd, name):
    """When fppd logged that `name` started playing, as seconds of the day."""
    import re
    return logged_at(fppd, r"GStreamer started playing: (?:\S*/)?" + re.escape(name) + "$")


def test_a_slow_audio_teardown_does_not_hold_up_the_next_song(fppd, audio):
    """A playlist of two 2 s songs whose pipeline teardowns each take 3 s
    (slownull.c holds the NULL transition, inside fppd's 10 s deadline): the
    second song starts as the first ends, not after its teardown.

    Regression: 89d1ef537. An audio-only pipeline's teardown -- the 250 ms
    silence flush and the NULL state change -- ran synchronously in Stop(),
    so every track change froze the show for as long as it took (~0.5 s on
    a Pi, and here the whole 3 s)."""
    import shims
    for name in ("A.wav", "B.wav"):
        write_tone_wav(os.path.join(fppd.media, "music", name), 2)
    fppd.write("playlists/Two.json", playlist("Two", [media_entry("A.wav"), media_entry("B.wav")]))
    fppd.start(preload=[shims.build("slownull.c")], extra_env={"SLOWNULL_MS": "3000"})
    fppd.command("Start Playlist", "Two", "false", "false")
    fppd.wait_for(lambda: started_at(fppd, "B.wav"), timeout=20, interval=0.2,
                  what="the second song to start")
    gap = started_at(fppd, "B.wav") - logged_at(fppd, "GStreamer sync: End of stream")
    assert gap < 1.5, f"the second song started {gap:.1f} s after the first ended"


def test_a_stopped_videos_teardown_runs_once(fppd, audio):
    """A video playing to an overlay model, stopped by Stop All Media: its
    pipeline is set to NULL once, not twice.

    Regression: f52d1499c. Stopping media that is still playing calls
    Stop() directly and then again through Close() in the destructor, and
    Stop() ran its whole teardown both times -- the 250 ms silence flush,
    the NULL state change, the 150 ms DRM release sleep -- adding ~400 ms of
    dead time to every clip change (and pushing a MultiSync remote further
    behind the master with each one). A video, since an audio-only
    pipeline's teardown has since moved off Stop()'s own path (89d1ef537)."""
    from test_video import make_video, overlay_consumer, setup
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=20)
    setup(fppd, [overlay_consumer()])
    fppd.settings(LogLevel_MediaOut="debug")
    fppd.start()
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: "GStreamer started playing" in fppd.log(), timeout=15, interval=0.2,
                  what="the video to start")
    time.sleep(2)
    fppd.command("Stop All Media")
    fppd.wait_for(lambda: "Stop() - pipeline NULL complete" in fppd.log(), timeout=15,
                  interval=0.2, what="the video to be torn down")
    time.sleep(3)
    n = fppd.log().count("Stop() - setting pipeline to NULL")
    assert n == 1, f"the pipeline was torn down {n} times"


def test_media_stopped_while_it_is_still_starting(fppd, audio):
    """Play Media of a song whose move to PLAYING is held for 3 s
    (med_holdplaying.c, as pipewiresink holds it while its node is
    missing), stopped by Stop All Media during the hold: the stop answers,
    and once the hold lets go nothing touches the freed output.

    Regression: a5b1c471c (issue #2695). Start() hands the PLAYING
    transition, the volume ramp and the video attach to a detached thread
    that captured `this`; a stop during the transition deleted the
    GStreamerOutput, and the thread then read m_volume and m_playing out of
    freed memory (ASan: heap-use-after-free in the Start thread's lambda)."""
    import shims
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 10)
    mark = os.path.join(fppd.media, "tmp", "playing-held")
    fppd.start(preload=[shims.build("med_holdplaying.c")], extra_env={"HOLDPLAYING_MARK": mark})
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    fppd.wait_for(lambda: os.path.exists(mark), timeout=15, interval=0.1,
                  what="the move to PLAYING to be held")
    fppd.command("Stop All Media")
    time.sleep(5)  # the hold lets go; the start thread carries on
    fppd.get("/fppd/status", timeout=10)


def remote_plays(fppd, name, seconds=3.0):
    """As a MultiSync master: open and start `name` on the remote under
    test, then sync it for `seconds`."""
    import socket
    from multisync import PORT, sync_packet
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))
    try:
        send("open", "media", 0, 0.0, name)
        send("start", "media", 0, 0.0, name)
        began = time.monotonic()
        while time.monotonic() - began < seconds:
            send("sync", "media", 0, time.monotonic() - began, name)
            time.sleep(0.5)
            fppd.get("/fppd/status", timeout=10)
    finally:
        sock.close()


def test_a_media_started_preset_sets_the_volume_on_a_remote(fppd, audio):
    """A MultiSync remote with a MEDIA_STARTED preset that sets the
    volume, told to start a song: the volume is set, the song plays, and
    fppd keeps answering.

    Regression: 3bf6b5db2 (StartMediaOutput). MEDIA_STARTED was triggered
    with mediaOutputLock held, and presets run inline: Volume Set takes
    mediaOutputLock again on the same thread, and the start
    self-deadlocked."""
    from test_commands_media import preset
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 10)
    fppd.write("config/commandPresets.json", {"commands": [preset("MEDIA_STARTED", "Volume Set", 42)]})
    fppd.settings(fppMode="remote")
    fppd.start()
    time.sleep(2)
    remote_plays(fppd, "Song.wav")
    s = status(fppd)
    assert s.get("media_filename") == "Song.wav", s
    assert s.get("volume") == 42, f"volume {s.get('volume')} after the MEDIA_STARTED preset"
    # Volume Set takes mediaOutputLock: it answers only if the start let go of it.
    fppd.command("Volume Set", "50", timeout=10)
    assert status(fppd).get("volume") == 50




def test_a_song_that_never_prerolls_gives_way_to_the_next(fppd, audio):
    """A playlist of two songs whose first never prerolls (med_holdread.c
    holds its first streaming-thread read until fppd tears the pipeline
    down, 12 s or more into the hold): the playlist gives up on it and plays
    the second song, instead of sitting on the first for good.

    Regression: da14a0b58. A pipeline that never reached a position was
    left alone: the stall watchdog only runs once there is a position, so
    m_playing stayed true, the playlist never advanced, and only a reboot
    recovered (a Pi's hardware decoder that stopped producing frames,
    issue #2695)."""
    import shims
    for name in ("A.wav", "B.wav"):
        write_tone_wav(os.path.join(fppd.media, "music", name), 5)
    tmp = os.path.join(fppd.media, "tmp")
    arm, mark = os.path.join(tmp, "arm"), os.path.join(tmp, "mark")
    open(arm, "w").close()
    fppd.write("playlists/Two.json", playlist("Two", [media_entry("A.wav"), media_entry("B.wav")]))
    fppd.start(preload=[shims.build("med_holdread.c")],
               extra_env={"HOLDREAD_NAME": "/A.wav", "HOLDREAD_ARM": arm, "HOLDREAD_MARK": mark,
                          "HOLDREAD_UNTIL_NULL": "12000"})
    fppd.command("Start Playlist", "Two", "false", "false", timeout=10)
    fppd.wait_for(lambda: os.path.exists(mark), timeout=15, interval=0.1,
                  what="A.wav's first read to be held")
    fppd.wait_for(lambda: started_at(fppd, "B.wav"), timeout=25, interval=0.5,
                  what="the playlist to give up on A.wav and play B.wav")
    assert "failed to preroll" in fppd.log()


def test_a_decoder_wedge_that_survives_a_restart_reboots(fppd, audio):
    """A playlist video whose hardware decoder never loads (vid_hwdecwedge.c,
    as in test_media.py), with the restart limit at 1 and the reboot limit
    at 2: the first wedge restarts fppd, the restarted fppd resumes the
    playlist and wedges again, and that second wedge-triggered restart asks
    for a reboot instead (med_noreboot.c stands in for /usr/sbin/reboot,
    so nothing is rebooted) and fppd exits for it.

    Regression: db0f7a394. A wedge in the decoder's firmware survives any
    number of fppd restarts, and with only the restart rung fppd looped
    restart, wedge, restart until someone rebooted by hand. Restarts are
    counted in /run/fppd (tmpfs: kept across fppd restarts, cleared by a
    reboot)."""
    import subprocess

    import pytest

    import shims
    from test_video import make_video, overlay_consumer, setup
    flags = subprocess.run(["pkg-config", "--cflags", "--libs", "gstreamer-1.0"], capture_output=True, text=True)
    if flags.returncode:
        pytest.skip("the GStreamer development files are not installed")
    so = shims.build("vid_hwdecwedge.c", libs=("-ldl", *flags.stdout.split()))
    plugins = os.path.join(fppd.media, "tmp", "gst-plugins")
    os.makedirs(plugins)
    os.symlink(so, os.path.join(plugins, "libgstvidhwdecwedge.so"))
    gst_env = {"GST_PLUGIN_PATH_1_0": plugins,
               "GST_REGISTRY_1_0": os.path.join(fppd.media, "tmp", "gst-registry.bin")}
    r = subprocess.run(["gst-inspect-1.0", "hwdecwedge"], env={**os.environ, **gst_env},
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, f"the stand-in decoder did not register: {r.stderr.strip()[-300:]}"
    os.makedirs("/run/fppd", exist_ok=True)
    state = "/run/fppd/gstreamer_wedge_restarts"
    if os.path.exists(state):
        os.unlink(state)
    reboots = os.path.join(fppd.media, "tmp", "reboots")
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"))
    setup(fppd, [overlay_consumer()])
    fppd.write("playlists/Vid.json", playlist("Vid", [
        {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Bars.mkv", "videoOut": "HDMI-A-1"}],
        repeat=1))
    fppd.settings(GStreamerWedgeRestartLimit="1", GStreamerWedgeRebootLimit="2")
    fppd.start(preload=[shims.build("med_noreboot.c")],
               extra_env={**gst_env, "HWDECWEDGE_WEDGE": "1", "NOREBOOT_LOG": reboots})
    fppd.exit_expected = True
    try:
        fppd.command("Start Playlist", "Vid", "true", "false")
        fppd.wait_for(lambda: os.path.exists(reboots), timeout=150, interval=1,
                      what="the second wedge-triggered restart to ask for a reboot")
        log = fppd.log()
        assert log.count("Starting main processing loop") == 2, "fppd did not restart once before rebooting"
        assert "REBOOTING the system" in log
    finally:
        if os.path.exists(state):
            os.unlink(state)


def test_script_plugin_callbacks_with_a_long_lived_child(fppd, audio):
    """fppd with a child process that never exits (med_keepchild.c, as
    gst_ptp_init()'s gst-ptp-helper is) and a script plugin registered for
    the media and playlist callbacks: the plugin loads, the API comes up,
    and a playlist song's callbacks run and come back.

    Regression: 5405e642a. Each callback, and the plugin's `--list` at
    load, waited for its script with wait(NULL). fppd sets SA_NOCLDWAIT, so
    wait(NULL) returns only once every child has exited, and with a
    permanent child it never did: fppd never reached its main loop or
    started the API."""
    import shims
    from test_playlist_media import media_callbacks
    from test_plugin_scripts import plugin
    d = plugin(fppd, types="media,playlist")
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 3)
    fppd.write("playlists/Song.json", playlist("Song", [media_entry("Song.wav")]))
    fppd.start(preload=[shims.build("med_keepchild.c")])
    fppd.command("Start Playlist", "Song", "false", "false", timeout=10)
    fppd.wait_for(lambda: media_callbacks(d), timeout=15, interval=0.2,
                  what="the plugin's media callback")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.2,
                  what="the song to end")
