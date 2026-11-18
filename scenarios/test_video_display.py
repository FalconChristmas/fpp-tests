"""The display between videos: a looping video doesn't drop to the console.

Each track's pipeline used to own its kmssink, so every track change let go
of the display: the video plane went dark and the console underneath showed
until the next track's first frame -- about a third of a second on a Pi 5,
at every pass of a looping video. The display now runs on a pipeline of its
own (VideoDisplay) that each track feeds through an appsink, and it stays up
between tracks with the last frame on screen.

Runs anywhere, Docker included: the display is the fake card of fakedrm.c
and the kmssink fakekms.c, which logs when it starts, shows a frame and
stops (test_video.kms_events()).
"""

import os
import re
import time
from datetime import datetime

import fakedrm
from audio import write_tone_wav
from show import status
from test_video import kms_events, make_video

CONNECTOR = fakedrm.CONNECTOR
CONNECTOR_ID = 35


def media_entry(name, video_out=CONNECTOR):
    return {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": name, "videoOut": video_out}


def video_playlist(name, video, repeat=1):
    return {"name": name, "repeat": repeat, "loopCount": 0, "leadIn": [], "leadOut": [],
            "mainPlaylist": [media_entry(video)]}


def display_events(fppd):
    return [e for e in kms_events(fppd) if e[2] == CONNECTOR_ID]


def starts(fppd):
    return fppd.log().count("GStreamer started playing: Loop.mkv")


def play_loop(fppd, passes, audio_track=True):
    """A 2 s video looping in a playlist, played until its pass `passes`
    has been on screen for a second."""
    make_video(os.path.join(fppd.media, "videos", "Loop.mkv"), seconds=2, audio=audio_track)
    fppd.write("playlists/Loop.json", video_playlist("Loop", "Loop.mkv"))
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Start Playlist", "Loop", "true", "false")
    fppd.wait_for(lambda: starts(fppd) >= passes, timeout=30, interval=0.2,
                  what=f"pass {passes} of the looping video")
    time.sleep(1)


def gaps(events):
    frames = [t for e, _, _, t in events if e == "frame"]
    return [b - a for a, b in zip(frames, frames[1:])]


def check_display_stays_up(fppd):
    events = display_events(fppd)
    kinds = [e for e, *_ in events]
    assert "frame" in kinds, f"no frame reached the display: {events[:5]!r}"
    longest = max(gaps(events) or [0])
    assert kinds.count("start") == 1 and "stop" not in kinds, (
        f"the display was let go between passes: {kinds.count('start')} starts, "
        f"{kinds.count('stop')} stops; longest gap between frames {longest:.3f} s")


def test_a_looping_video_keeps_the_display_between_passes(fppd, audio):
    """Three passes of a looping video with sound: one display, started once,
    never stopped between passes.

    Fixed by efd1202fd (VideoDisplay). Before it the kmssink stopped at
    the end of every pass and a new one started with the next."""
    play_loop(fppd, passes=3)
    check_display_stays_up(fppd)


def test_a_looping_video_with_no_sound_keeps_the_display(fppd, audio):
    """The same with a video that has no sound, where the display's feed is
    the pipeline's only sink and so also what its position comes from."""
    play_loop(fppd, passes=3, audio_track=False)
    check_display_stays_up(fppd)


def test_the_display_closes_as_soon_as_the_playlist_stops(fppd, audio):
    """Stop Now on a looping video closes the display at once, giving the
    screen back, rather than leaving the last frame up.

    Fixed by 74e172214. Before it the display lingered 5 s after the last
    video, on the last frame."""
    play_loop(fppd, passes=1)

    def stops():
        return sum(1 for e, *_ in display_events(fppd) if e == "stop")

    before = stops()
    fppd.command("Stop Now")
    stopped = time.monotonic()
    fppd.wait_for(lambda: stops() > before, timeout=10, interval=0.1, what="the display to close")
    took = time.monotonic() - stopped
    assert took < 2, f"the display closed {took:.1f} s after the playlist stopped"


def test_each_pass_of_a_looping_video_starts_prepared(fppd, audio):
    """From the second pass on, each pass of a looping video plays the
    pipeline prepared in the last moments of the pass before it, rather than
    building one when the pass ends.

    Fixed by 74e172214 (Playlist::PrepareNextIfDue(),
    GStreamerOutput::Prepare())."""
    play_loop(fppd, passes=3)
    used = fppd.log().count("Using Loop.mkv prepared for slot 1")
    assert used >= 2, f"{used} of the passes after the first started from a prepared pipeline"


def test_a_prepare_overtaken_by_an_insert_leaves_the_playing_track_alone(fppd, audio):
    """A video prepared to play next is thrown away when an insert plays
    instead (as Remote Falcon's requests do), and while it waited it took
    nothing from the track playing: that track keeps its length in the
    status, the inserted song plays to its end through the output stream,
    and the playlist then goes on to the video, built afresh.

    Guards 74e172214: a prepared output that never played gives back no use
    of the output stream (closing the stream under the inserted song) and
    writes nothing to the slot's status."""
    make_video(os.path.join(fppd.media, "videos", "First.mkv"), seconds=4)
    make_video(os.path.join(fppd.media, "videos", "Next.mkv"), seconds=2)
    write_tone_wav(os.path.join(fppd.media, "music", "Request.wav"), 8)
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0, "leadIn": [],
                                       "leadOut": [], "mainPlaylist": [media_entry("First.mkv"),
                                                                       media_entry("Next.mkv")]})
    fppd.write("playlists/Request.json", {"name": "Request", "repeat": 0, "loopCount": 0, "leadIn": [],
                                          "leadOut": [],
                                          "mainPlaylist": [media_entry("Request.wav", "--Disabled--")]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: "Preparing Next.mkv for slot 1" in fppd.log(), timeout=20, interval=0.1,
                  what="the next video to be prepared")
    fppd.command("Insert Playlist After Current", "Request", "0", "0")

    lengths = set()
    while status(fppd).get("current_song") == "First.mkv":
        st = status(fppd)
        lengths.add(int(st.get("seconds_total", 0) or 0))
        time.sleep(0.1)
    assert 2 not in lengths, f"the playing 4 s video's length in the status went to {sorted(lengths)} s"

    fppd.wait_for(lambda: status(fppd).get("current_song") == "Request.wav", timeout=10,
                  what="the inserted song")
    started = time.monotonic()
    fppd.wait_for(lambda: status(fppd).get("current_song") != "Request.wav", timeout=20, interval=0.1,
                  what="the inserted song to end")
    played = time.monotonic() - started
    assert played >= 7, f"the 8 s inserted song stopped after {played:.1f} s"
    assert "Discarding Next.mkv prepared for slot 1" in fppd.log(), "the overtaken prepare was not discarded"
    fppd.wait_for(lambda: "GStreamer started playing: Next.mkv" in fppd.log(), timeout=10,
                  what="the playlist to go on to the next video")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, what="the playlist to end")
    # fakekms stamps its events on this container's monotonic clock.
    idle_at = time.monotonic()
    fppd.wait_for(lambda: any(e == "stop" and t >= idle_at - 1 for e, _, _, t in display_events(fppd)),
                  timeout=5, interval=0.2, what="the display to close once the playlist is over")


def test_a_video_inserted_to_play_next_starts_prepared(fppd, audio):
    """Insert Playlist After Current with a video playlist -- Remote Falcon's
    requests -- inside the playing entry's last moments, after its own next
    entry was prepared: the inserted video is prepared in its place, and
    starts from that.

    Fixed by 2afa20796 (Playlist::PrepareInsertedPlaylist())."""
    make_video(os.path.join(fppd.media, "videos", "First.mkv"), seconds=4)
    make_video(os.path.join(fppd.media, "videos", "Next.mkv"), seconds=2)
    make_video(os.path.join(fppd.media, "videos", "Requested.mkv"), seconds=2)
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0, "leadIn": [],
                                       "leadOut": [], "mainPlaylist": [media_entry("First.mkv"),
                                                                       media_entry("Next.mkv")]})
    fppd.write("playlists/Request.json", {"name": "Request", "repeat": 0, "loopCount": 0, "leadIn": [],
                                          "leadOut": [], "mainPlaylist": [media_entry("Requested.mkv")]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: "Preparing Next.mkv for slot 1" in fppd.log(), timeout=20, interval=0.1,
                  what="the next video to be prepared")
    fppd.command("Insert Playlist After Current", "Request", "0", "0")
    fppd.wait_for(lambda: "GStreamer started playing: Requested.mkv" in fppd.log(), timeout=15,
                  what="the inserted video to play")
    assert "Using Requested.mkv prepared for slot 1" in fppd.log(), \
        "the inserted video was built when it started, not prepared"



def test_the_playlist_an_insert_returns_to_starts_its_next_video_prepared(fppd, audio):
    """When an inserted playlist (Insert Playlist After Current: Remote
    Falcon's requests) ends, the playlist it interrupted goes on with its
    next video, and that video was prepared in the last moments of the
    insert: it starts from the prepared pipeline, and the display stays up
    from the first video to the last.

    Fixed by 3cb433fbf (Playlist::PrepareParentsNext()): the insert's last entry
    saw only the end of its own playlist, prepared nothing, and the display
    closed and reopened before the next video."""
    make_video(os.path.join(fppd.media, "videos", "First.mkv"), seconds=2)
    make_video(os.path.join(fppd.media, "videos", "Next.mkv"), seconds=2)
    make_video(os.path.join(fppd.media, "videos", "Requested.mkv"), seconds=3)
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0, "leadIn": [],
                                       "leadOut": [], "mainPlaylist": [media_entry("First.mkv"),
                                                                       media_entry("Next.mkv")]})
    fppd.write("playlists/Request.json", {"name": "Request", "repeat": 0, "loopCount": 0, "leadIn": [],
                                          "leadOut": [], "mainPlaylist": [media_entry("Requested.mkv")]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: "GStreamer started playing: First.mkv" in fppd.log(), timeout=15,
                  what="the first video")
    fppd.command("Insert Playlist After Current", "Request", "0", "0")
    fppd.wait_for(lambda: "GStreamer started playing: Requested.mkv" in fppd.log(), timeout=15,
                  what="the inserted video")
    fppd.wait_for(lambda: "GStreamer started playing: Next.mkv" in fppd.log(), timeout=15,
                  what="the playlist to go on to its next video after the insert")
    time.sleep(0.5)
    assert "Using Next.mkv prepared for slot 1" in fppd.log(), \
        "the video after the insert was built when it started, not prepared"
    check_display_stays_up(fppd)


LOG_TIME = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) ")


def log_times(fppd, text):
    """When fppd logged each line containing `text`, in seconds."""
    times = []
    for line in fppd.log().splitlines():
        if text in line:
            m = LOG_TIME.match(line)
            if m:
                times.append(datetime.strptime(m[1], "%Y-%m-%d %H:%M:%S.%f").timestamp())
    return times


def test_a_virtual_matrix_on_the_port_shows_between_videos(fppd, audio):
    """A video, then a song (the lights on a Virtual Matrix on the same HDMI
    port), then a video: the matrix is back as the song starts, and keeps the
    screen until the second video starts -- not until the display had
    lingered, nor from the moment the second video was prepared.

    Fixed by 74e172214. Before it the display stayed up 5 s after the first
    video, so the song's first seconds showed that video's last frame, and
    preparing the second video brought the display up again 1.5 s early, with
    nothing on it."""
    w, h = 64, 32
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "enabled": 1, "type": "VirtualMatrix", "description": "Matrix", "device": CONNECTOR,
        "width": w, "height": h, "layout": f"{w}x{h}", "scaling": "Hardware", "colorOrder": "RGB",
        "invert": 0, "xoff": 0, "yoff": 0, "startChannel": 1, "channelCount": w * h * 3}]})
    make_video(os.path.join(fppd.media, "videos", "First.mkv"), seconds=3)
    make_video(os.path.join(fppd.media, "videos", "Second.mkv"), seconds=2)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 6)
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0, "leadIn": [], "leadOut": [],
                                       "mainPlaylist": [media_entry("First.mkv"),
                                                        media_entry("Song.wav", "--Disabled--"),
                                                        media_entry("Second.mkv")]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="info", LogLevel_MediaOut="debug")
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "KMSFrameBuffer: " + CONNECTOR + " mode" in fppd.log(), timeout=15,
                  what="the Virtual Matrix to light the port")
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: "GStreamer started playing: Second.mkv" in fppd.log(), timeout=30,
                  what="the second video")
    time.sleep(1)

    song = log_times(fppd, "GStreamer started playing: Song.wav")[0]
    second = log_times(fppd, "GStreamer started playing: Second.mkv")[0]
    back = [t for t in log_times(fppd, "media finished, showing output again") if t < second]
    aside = [t for t in log_times(fppd, "media is playing here, standing aside") if t > song]
    assert back, "the Virtual Matrix never came back after the first video"
    assert back[-1] - song < 1.0, \
        f"the Virtual Matrix came back {back[-1] - song:.1f} s into the song"
    assert aside and aside[0] > second - 0.5, \
        f"the Virtual Matrix stood aside {second - aside[0]:.1f} s before the second video started"


def test_a_remote_starts_the_masters_next_video_prepared(fppd, audio):
    """A MultiSync remote told by the master which video comes next
    (SYNC_PKT_PREPARE, sent as the master prepares it) has it ready: when the
    master moves on -- stop, open, start -- the remote starts the next video
    from the prepared pipeline, and its display stays up across the change.

    Fixed by 31dc99c09. Before it a remote opened each video cold
    when the master's open arrived, and its display closed in between."""
    from multisync import PORT, sync_packet
    import socket
    make_video(os.path.join(fppd.media, "videos", "A.mkv"), seconds=3)
    make_video(os.path.join(fppd.media, "videos", "B.mkv"), seconds=3)
    fppd.settings(fppMode="remote", VideoOutput=CONNECTOR, DisableFakeNetworkBridges="1",
                  LogLevel_MediaOut="debug", LogLevel_Sync="debug")
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))
    try:
        time.sleep(2)
        send("open", "media", 0, 0.0, "A.mkv")
        send("start", "media", 0, 0.0, "A.mkv")
        fppd.wait_for(lambda: re.search(r"GStreamer started playing: \S*A\.mkv", fppd.log()), timeout=15,
                      what="the remote to play A.mkv")
        for t in (0.5, 1.0, 1.5, 2.0, 2.5):
            send("sync", "media", 0, t, "A.mkv")
            if t == 1.5:
                send("prepare", "media", 0, 0.0, "B.mkv")
            time.sleep(0.5)
        fppd.wait_for(lambda: re.search(r"Preparing \S*B\.mkv for slot 1", fppd.log()), timeout=5,
                      what="the remote to prepare B.mkv")
        send("stop", "media", 0, 3.0, "A.mkv")
        send("open", "media", 0, 0.0, "B.mkv")
        send("start", "media", 0, 0.0, "B.mkv")
        fppd.wait_for(lambda: re.search(r"GStreamer started playing: \S*B\.mkv", fppd.log()), timeout=15,
                      what="the remote to play B.mkv")
        time.sleep(1)
        assert re.search(r"Using \S*B\.mkv prepared for slot 1", fppd.log()), \
            "the remote built B.mkv when the master's open came, not from what it prepared"
        kinds = [e for e, *_ in display_events(fppd)]
        assert kinds.count("start") == 1 and "stop" not in kinds, \
            f"the remote's display was let go between the videos: {kinds.count('start')} starts, {kinds.count('stop')} stops"
        send("stop", "media", 0, 1.0, "B.mkv")
    finally:
        sock.close()
