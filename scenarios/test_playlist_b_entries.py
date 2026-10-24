"""Playlist entry types at their edges: a URL step to a host that never
answers, branch settings FPP can't use, entry types FPP no longer has, image
entries that fail to load or don't match their model, and a media entry's
companion media.

Entries append digits to a trace (see test_playlist_entries.py).
"""

import contextlib
import os
import socket
import time

import pytest

from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import branch, http_server, pause, playlist, run, status, step, trace


def warnings(fppd):
    return [str(w) for w in status(fppd).get("warnings", [])]


@contextlib.contextmanager
def silent_server():
    """A port that takes connections (the kernel completes the handshake
    into the listen backlog) and never reads or answers a request."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(16)
    try:
        yield s.getsockname()[1]
    finally:
        s.close()


def test_a_url_step_to_a_host_that_never_answers_moves_on(fppd):
    """A URL step to a host that takes the connection and never answers:
    the playlist moves on to the next entry at once, and status keeps
    answering promptly while the request is outstanding.

    Regression: e8ac78871. The step did a blocking request on the main
    loop, holding the playlist lock, for up to its 30 s timeout: the show,
    the scheduler and the status API all stopped until it gave up.
    """
    with silent_server() as port:
        fppd.write("playlists/P.json", playlist("P", main=[
            step(1), {"type": "url", "enabled": 1, "playOnce": 0, "method": "GET",
                      "url": f"http://127.0.0.1:{port}/hook", "data": ""},
            step(2), pause(5)]))
        fppd.start()
        start(fppd, "P")
        wait_trace(fppd, "12", timeout=3)
        worst = 0
        until = time.monotonic() + 3
        while time.monotonic() < until:
            t = time.monotonic()
            status(fppd)
            worst = max(worst, time.monotonic() - t)
            time.sleep(0.1)
        assert worst < 1.0, f"status took {worst:.1f} s while the URL step's request hung"
        fppd.command("Stop Now")
        wait_idle(fppd)


def test_a_url_step_posts_exactly_its_body(fppd):
    """A POST URL step sends its data as the body, with a Content-Length of
    that data's length.

    Regression: 891579f56 (the URL half). The body length was a fixed 4096:
    curl sent that many bytes from the data's buffer, so a short body
    carried the heap after it to the remote host (and a longer one was cut
    off).
    """
    with http_server({}) as (port, got):
        fppd.write("playlists/P.json", playlist("P", main=[
            step(1), {"type": "url", "enabled": 1, "playOnce": 0, "method": "POST",
                      "url": f"http://127.0.0.1:{port}/hook", "data": "four"},
            step(2)]))
        fppd.start()
        assert run(fppd, "P") == "12"
        fppd.wait_for(lambda: got, what="the URL to be requested")
    assert got[0] == ("POST", "/hook", "four"), got


@pytest.mark.parametrize("kind", ["short time", "zero iterations"])
def test_a_branch_with_a_setting_fpp_cant_use_as_written(fppd, kind):
    """A branch whose time is written HH:MM ("8:00") reads it as 08:00:00;
    one with an iteration count of 0 is taken as 1, with a warning. Either
    way the playlist plays through it and fppd survives.

    Regression: 891579f56 (the branch half). The time was split on ':' and
    its third part read without a check -- past the end of a two-part
    vector, an out-of-bounds read in Init() on the thread that started the
    playlist. A count of 0 reached a modulo by zero in the Loop test: a
    SIGFPE on x86, a quietly wrong branch on arm64.
    """
    if kind == "short time":
        b = branch("Time", startTime="8:00", endTime="23:59:59")
    else:
        b = branch("Loop", iterationStart=1, iterationCount=0)
    fppd.write("playlists/P.json", playlist("P", main=[step(1), b, step(2)]))
    fppd.start()
    assert run(fppd, "P") == "12"
    w = [x for x in warnings(fppd) if "branch" in x.lower()]
    if kind == "short time":
        assert not w, w
    else:
        assert any("invalid iteration count" in x for x in w), warnings(fppd)


@pytest.mark.parametrize("kind", ["plugin", "effect"])
def test_an_entry_type_fpp_no_longer_has_is_skipped(fppd, kind):
    """A hand-written playlist with an "effect" or "plugin" entry: the
    entry is skipped with an unknown-type warning, and the rest plays.

    Regression: b6e638f17, which removed the two never-finished entry
    types. A "plugin" entry was a stub that never finished, so the playlist
    stalled on it for good; an "effect" entry was dropped without a word
    (its Init() looked for a member it never read). The entries around it
    are URL steps, not the trace: the tree before it has no user variables.
    """
    from test_playlist_b_teardown import bare, mark, marks
    e = {"type": kind, "enabled": 1, "playOnce": 0}
    if kind == "effect":
        e.update(effectName="Nope", startChannel=1, repeat=0, blocking=0)
    with http_server({}) as (port, got):
        fppd.write("playlists/P.json", bare("P", [mark(port, 1), e, mark(port, 2)]))
        fppd.start()
        start(fppd, "P")
        fppd.wait_for(lambda: status_name(fppd) == "idle" and "2" in marks(got), timeout=10,
                      interval=0.2, what="the playlist to play past the entry and end")
        assert marks(got) == ["1", "2"], marks(got)
    assert any(f"Unknown playlist entry type: {kind}" in w for w in warnings(fppd)), \
        warnings(fppd)


# --- image entries -----------------------------------------------------------


def models(fppd):
    return {m.get("Name"): m for m in fppd.get("/overlays/models")}


def test_an_image_entry_that_fails_to_load_leaves_its_model_off(fppd):
    """An image entry with a model but no image path fails to load: the
    playlist plays without it, and the model -- disabled before -- is left
    disabled, not lit over the show.

    Regression: ed3fa2aeb. An entry whose Init() failed was dropped without
    being deleted: besides the leak, its destructor never ran, and that is
    what turns the model back off after Init() has enabled it.
    """
    from test_overlays import matrix, setup
    setup(fppd, [matrix()])
    fppd.write("playlists/P.json", playlist("P", main=[
        step(1), {"type": "image", "enabled": 1, "playOnce": 0, "modelName": "M"}, step(2)]))
    fppd.start()
    assert models(fppd)["M"].get("isActive") == 0
    assert run(fppd, "P") == "12"
    assert any("missing the image path" in w for w in warnings(fppd)), warnings(fppd)
    time.sleep(0.5)
    assert models(fppd)["M"].get("isActive") == 0, f"the model was left enabled: {models(fppd)['M']}"


def test_an_image_as_wide_as_its_model_but_taller_is_scaled(fppd):
    """An image as wide as the model but twice as tall, its top half one
    colour and its bottom half another, is scaled to the model: the
    bottom half shows (scaled and blended, as some green), not
    only the top half's blue.

    Regression: 1c85b5ac2 (the scaling half). The image was scaled only
    when both of its dimensions differed from the model's; this one wasn't,
    and the copy into the model's buffer, cut to the buffer's size, drew
    only the image's top half -- the whole model in the first colour.
    """
    from ddp import DdpReceiver
    from test_overlays import CHANNELS, HEIGHT, WIDTH, matrix, setup
    top, bottom = (0, 0, 70), (0, 90, 0)
    path = os.path.join(fppd.media, "images", "Tall.ppm")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    h = HEIGHT * 2
    with open(path, "wb") as f:
        f.write(b"P6\n%d %d\n255\n" % (WIDTH, h) +
                bytes(top) * (WIDTH * HEIGHT) + bytes(bottom) * (WIDTH * HEIGHT))
    setup(fppd, [matrix()])
    fppd.write("playlists/Img.json", {"name": "Img", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": [{"type": "image", "enabled": 1,
                                                        "playOnce": 0, "modelName": "M",
                                                        "imagePath": "Tall.ppm"}, pause(3)],
                                      "leadOut": []})
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Img", "false", "false")
        time.sleep(2.5)
        frame = rx.last()
    assert frame is not None, "nothing on the wire"
    px = [tuple(frame[i:i + 3]) for i in range(0, WIDTH * HEIGHT * 3, 3)]
    assert any(p[1] >= 30 for p in px), f"none of the image's bottom half was drawn: {px}"
    assert any(p[2] >= 30 for p in px), f"none of the image's top half was drawn: {px}"


def rss_kb(pid):
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    return 0


def test_image_entries_free_their_buffers(fppd):
    """Loading a playlist of image entries over and over on a 400x400
    model doesn't grow fppd by a buffer per entry per load.

    Regression: 1c85b5ac2 (the leak half). The entry's image buffer --
    width x height x 3 bytes, here 480 KB -- was never freed, so every load
    of a playlist with an image entry kept one. 40 loads of four entries
    kept 75 MB; with the fix fppd grows by a few MB. ASan's quarantine is
    off so freed memory is reused as it would be in a normal build.

    Measured after a warm-up, against half the leak's own size: each load
    starts and joins four prep threads, and the thread-stack and allocator
    caches that fills grow with the machine (an ASan build on 16 cores grew
    35 MB over the first 40 loads and 0.46 MB a load after, a debug build
    24 MB and then nothing), so a fixed cap from the first loads failed on
    a large host with no leak.
    """
    from test_overlays import matrix, setup
    w = h = 400
    setup(fppd, [matrix(width=w, height=h)], channels=w * h * 3)
    path = os.path.join(fppd.media, "images", "Img.ppm")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"P6\n%d %d\n255\n" % (w, h) + bytes((0, 0, 50)) * (w * h))
    img = {"type": "image", "enabled": 1, "playOnce": 0, "modelName": "M", "imagePath": "Img.ppm"}
    fppd.write("playlists/P.json", playlist("P", main=[step(1), img, img, img, img, pause(30)]))
    fppd.start(extra_env={"ASAN_OPTIONS": (
        "halt_on_error=1:detect_leaks=0:abort_on_error=0:quarantine_size_mb=0:"
        f"log_path={fppd.media}/logs/asan")})

    def load_and_stop():
        fppd.command("Set Variable", "trace", "Value", "0")
        start(fppd, "P")
        wait_trace(fppd, "1")
        fppd.command("Stop Now")
        wait_idle(fppd)

    loads = 40
    for _ in range(loads):
        load_and_stop()
    time.sleep(1)
    before = rss_kb(fppd.proc.pid)
    for _ in range(loads):
        load_and_stop()
    time.sleep(1)
    grew_mb = (rss_kb(fppd.proc.pid) - before) / 1024
    leak_mb = loads * 4 * w * h * 3 / (1024 * 1024)
    assert grew_mb < leak_mb / 2, \
        f"fppd grew {grew_mb:.0f} MB over {loads} loads of four image entries (a buffer each would be {leak_mb:.0f} MB)"


# --- companion media -----------------------------------------------------------


@pytest.mark.parametrize("ending", ["finishes", "Stop Now", "pause"])
def test_companion_media_lives_and_dies_with_its_entry(fppd, audio, ending):
    """A media entry with extraMedia on slot 2: the companion plays on slot
    2 while the entry plays, and is stopped when the entry's media
    finishes, on Stop Now, and while the playlist is paused.

    Feature: 579586dae. Before it a second feed had to be started by a
    command entry and stopped by hand, and anything ending the entry
    another way left it playing.
    """
    from audio import write_tone_wav
    from test_media_commands import slot_status
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 3)
    write_tone_wav(os.path.join(fppd.media, "music", "Comp.wav"), 20, freq=600)
    fppd.write("playlists/P.json", playlist("P", main=[
        {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Song.wav",
         "extraMedia": [{"mediaName": "Comp.wav", "slot": 2}]},
        pause(30)]))
    fppd.start()

    def slot2():
        return (slot_status(fppd, 2) or {}).get("status")
    start(fppd, "P")
    fppd.wait_for(lambda: slot2() == "playing", timeout=5, what="the companion on slot 2")
    if ending == "finishes":
        # The song ends after 3 s; the playlist moves on to its pause.
        fppd.wait_for(lambda: slot2() != "playing", timeout=8,
                      what="the companion to stop with the song")
        assert status_name(fppd) == "playing"
    elif ending == "Stop Now":
        fppd.command("Stop Now")
        wait_idle(fppd)
        fppd.wait_for(lambda: slot2() != "playing", timeout=3,
                      what="the companion to stop on Stop Now")
    else:
        fppd.command("Pause Playlist")
        fppd.wait_for(lambda: status_name(fppd) == "paused", what="status paused")
        fppd.wait_for(lambda: slot2() != "playing", timeout=3,
                      what="the companion to stop while paused")
        fppd.command("Resume Playlist")
        fppd.wait_for(lambda: slot2() == "playing", timeout=5,
                      what="the companion to play again on resume")
    fppd.command("Stop Now")
    wait_idle(fppd)
