"""Video input sources: the shape of the picture a source publishes, and
YouTube sources resolved through yt-dlp."""

import functools
import http.server
import os
import threading

from test_video import (H, MODEL, SOURCE, W, make_video, overlay_consumer, pixels, setup, source,
                        wait_for_bars, ytdlp_stand_in)


def lit(px):
    return sum(px) > 150


def test_a_source_of_another_shape_is_letterboxed_not_squashed(fppd, audio):
    """A 4:3 video file on a source configured 16:9 (320x180): the source
    pads the picture with black bars at the sides instead of squeezing it,
    so the 4:3 model it feeds shows black columns at its left and right
    edges and the bars between them.

    Regression: c32712c71. The source's caps fixed only width and height,
    so videoscale met them by changing the pixel aspect ratio (320x180 at
    3/4): the frame still displayed 4:3, the outputs took it as such, and
    the model was filled edge to edge."""
    path = os.path.join(fppd.media, "videos", "Bars.mkv")
    make_video(path, seconds=30)
    setup(fppd, [overlay_consumer(SOURCE)],
          [source("urisrc", uri="file://" + path, width=320, height=180)])
    fppd.start()

    def shape():
        px = pixels(fppd)
        mid = px[H // 2]
        return (not lit(mid[1]) and not lit(mid[W - 2]) and lit(mid[W // 2])), [int(lit(p)) for p in mid]
    seen = []

    def boxed():
        try:
            ok, row = shape()
        except (KeyError, TypeError, IndexError):
            return False
        if row not in seen:
            seen.append(row)
        return ok
    try:
        fppd.wait_for(boxed, timeout=20, interval=0.2, what="the model to show the picture pillarboxed")
    except TimeoutError as e:
        raise AssertionError(f"{e}; the middle row (1 = lit) went {seen[-3:]}") from None


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    """An HTTP server for `directory` on a free local port: (server, port)."""
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                                            functools.partial(_Quiet, directory=directory))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def test_a_youtube_source_plays_what_yt_dlp_resolves_it_to(fppd, audio):
    """A YouTube source whose yt-dlp warns on stderr before printing the
    stream URL and its frame rate: the source plays that URL (the model
    shows its bars), at the stream's 24 fps rather than the configured 30.

    Coverage of 8282b3456, which folds yt-dlp's stderr into what fppd reads:
    the warning has to be passed over to find the URL."""
    videos = os.path.join(fppd.media, "videos")
    make_video(os.path.join(videos, "Bars.mkv"), seconds=30)
    httpd, port = serve(videos)
    try:
        env = ytdlp_stand_in(fppd, "echo 'WARNING: [youtube] x: nsig extraction failed' >&2\n"
                                   f"echo http://127.0.0.1:{port}/Bars.mkv\necho 24.0")
        setup(fppd, [overlay_consumer(SOURCE)],
              [source("urisrc", uri="https://www.youtube.com/watch?v=x", framerate=30)])
        fppd.start(extra_env=env)
        wait_for_bars(fppd, timeout=25)
        assert "yt-dlp detected 24fps for 'Test', capped to configured 30fps -> using 24fps" in fppd.log()
    finally:
        httpd.shutdown()


def test_a_youtube_source_that_yt_dlp_refuses_logs_its_reason(fppd, audio):
    """A YouTube source whose yt-dlp fails with its own error message: the
    source doesn't start, and fppd's log carries yt-dlp's reason.

    Regression: 8282b3456. yt-dlp's stderr went to /dev/null, so every
    failure was logged as the same "returned no valid URL", and the
    reason -- a stale yt-dlp, a bot check -- was lost."""
    reason = "ERROR: [youtube] x: Sign in to confirm you are not a bot"
    env = ytdlp_stand_in(fppd, f"echo '{reason}' >&2\nexit 1")
    setup(fppd, [overlay_consumer(SOURCE)], [source("urisrc", uri="https://www.youtube.com/watch?v=x")])
    fppd.start(extra_env=env)
    fppd.wait_for(lambda: "yt-dlp could not resolve the URL for 'Test'" in fppd.log(), timeout=20,
                  what="the failed resolution to be logged")
    line = [l for l in fppd.log().splitlines() if "yt-dlp could not resolve the URL for 'Test'" in l][0]
    assert "Sign in to confirm you are not a bot" in line, line


def test_a_youtube_source_with_audio_asks_for_the_better_audio_first(fppd, audio):
    """A YouTube source with audio on: the yt-dlp call that resolves its
    audio asks for HLS audio 234 (high quality) before 233, and DASH AAC
    140 (128k) before 139 (HE-AAC 48k), and the source plays what that
    resolves to.

    Regression: 3b455f2a8. The order was 233/234/139/140, so yt-dlp picked
    the low-quality stream whenever both were offered."""
    from test_video import yt_dlp_calls
    videos = os.path.join(fppd.media, "videos")
    make_video(os.path.join(videos, "Bars.mkv"), seconds=30)
    httpd, port = serve(videos)
    try:
        env = ytdlp_stand_in(fppd, f"echo http://127.0.0.1:{port}/Bars.mkv\necho 10.0")
        setup(fppd, [overlay_consumer(SOURCE)],
              [source("urisrc", uri="https://www.youtube.com/watch?v=x", audioEnabled=True)])
        fppd.start(extra_env=env)
        wait_for_bars(fppd, timeout=25)
    finally:
        httpd.shutdown()
    formats = [c[c.index("-f") + 1] for c in yt_dlp_calls(fppd) if "-f" in c]
    audio_formats = [f for f in formats if "bestaudio" in f]
    assert audio_formats, f"no yt-dlp call asked for audio: {formats}"
    assert all(f.startswith("234/233/140/139/") for f in audio_formats), audio_formats
