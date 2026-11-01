"""Image playlist entries: an image file (or one from a folder) drawn onto a
pixel overlay model, checked on the wire."""

import os
import time

from ddp import DdpReceiver
from test_overlays import CHANNELS, HEIGHT, WIDTH, matrix, setup


def ppm(path, w, h, rgb):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"P6\n%d %d\n255\n" % (w, h) + bytes(rgb) * (w * h))


def image_entry(path):
    return {"type": "image", "enabled": 1, "playOnce": 0, "modelName": "M", "imagePath": path}


def pause(seconds):
    return {"type": "pause", "enabled": 1, "playOnce": 0, "duration": seconds}


def show_image(fppd, path, hold=3):
    """Play [image, pause] and return the frames sent during the pause."""
    fppd.write("playlists/Img.json", {"name": "Img", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": [image_entry(path), pause(hold)],
                                      "leadOut": []})
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Img", "false", "false")
        time.sleep(hold - 0.5)
        return rx.last()


def lit_with(frame, rgb):
    return frame is not None and frame[:WIDTH * HEIGHT * 3] == bytes(rgb) * (WIDTH * HEIGHT)


def test_an_image_the_size_of_the_model_is_drawn(fppd):
    # Also 368a70804: the entry draws into a pixel overlay model (nothing
    # reaches the wire when the draw is left out).
    setup(fppd, [matrix()])
    ppm(os.path.join(fppd.media, "images", "Exact.ppm"), WIDTH, HEIGHT, (0, 0, 77))
    frame = show_image(fppd, "Exact.ppm")
    assert lit_with(frame, (0, 0, 77)), frame and frame[:12].hex()


def test_an_image_that_must_be_scaled_is_drawn_without_a_cache_folder(fppd):
    """A larger image is scaled to the model and drawn, also when the media
    folder has no cache folder to keep the scaled copy in -- the cache is an
    optimisation, not a step the image has to get through.

    Regression: 728e00799. The scaled copy was written to the cache
    before the image was converted for the model, inside the same try: a
    write that failed threw past the conversion, and the entry drew
    nothing."""
    setup(fppd, [matrix()])
    ppm(os.path.join(fppd.media, "images", "Big.ppm"), WIDTH * 4, HEIGHT * 4, (0, 66, 0))
    assert not os.path.exists(os.path.join(fppd.media, "cache"))
    frame = show_image(fppd, "Big.ppm")
    assert lit_with(frame, (0, 66, 0)), frame and frame[:12].hex()


def test_a_folder_entry_only_draws_its_images(fppd):
    """An entry naming a folder draws one of the images in it, or in a
    folder inside it: never a subfolder or another file it finds there.
    Several entries from the folder each draw an image.

    Regression: 728e00799. The folder's walk listed every entry,
    subfolders and non-image files included, and one picked at random
    failed to read: that entry drew nothing."""
    setup(fppd, [matrix()])
    base = os.path.join(fppd.media, "images", "Set")
    ppm(os.path.join(base, "a.ppm"), WIDTH, HEIGHT, (0, 0, 55))
    ppm(os.path.join(base, "inner", "b.ppm"), WIDTH, HEIGHT, (0, 0, 55))
    os.makedirs(os.path.join(base, "empty"))
    with open(os.path.join(base, "notes.txt"), "w") as f:
        f.write("not an image\n")
    entries = []
    for _ in range(8):
        entries += [image_entry("Set"), pause(1)]
    fppd.write("playlists/Img.json", {"name": "Img", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": entries, "leadOut": []})
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Img", "false", "false")
        time.sleep(17)
        frames = rx.snapshot()
    bad = [l for l in fppd.log().splitlines()
           if "GraphicsMagick exception" in l or "Exception preparing image" in l]
    assert not bad, bad[:3]
    assert any(lit_with(d, (0, 0, 55)) for t, d in frames)


def run_with_trace(fppd, entries, timeout=10):
    """Play `entries` then a step that appends 1 to the trace; wait for the
    playlist to end and return the trace."""
    from test_playlist_entries import playlist, run, step
    fppd.write("playlists/Img.json", playlist("Img", main=list(entries) + [step(1)]))
    fppd.start()
    return run(fppd, "Img", timeout=timeout)


def test_an_image_entry_with_no_file_finishes(fppd):
    """An image entry whose file doesn't exist finishes, and the playlist
    carries on, with a few log lines rather than a stream of them.

    Regression: 1cc014ac8. With nothing to show the image was never marked
    prepared, so the prep thread looped flat out from the moment the
    playlist loaded, logging every pass, and the entry never finished: the
    playlist stalled on it.
    """
    setup(fppd, [matrix()])
    assert run_with_trace(fppd, [image_entry("Nope.ppm")]) == "1"
    n = fppd.log().count("No files found in GetNextFile")
    assert n < 50, f"{n} 'No files found' lines"


def test_an_image_folder_of_broken_links_finishes(fppd):
    """An image entry naming a folder whose only file is a broken link
    finishes, and fppd survives.

    Regression: 1cc014ac8. Picking the next file recursed once per missing
    file and refilled the list whenever it ran dry, so a folder of broken
    links recursed until the prep thread's stack overflowed.
    """
    setup(fppd, [matrix()])
    os.makedirs(os.path.join(fppd.media, "images", "Broken"))
    os.symlink("/nonexistent/x.ppm", os.path.join(fppd.media, "images", "Broken", "x.ppm"))
    assert run_with_trace(fppd, [image_entry("Broken")]) == "1"


def test_an_image_on_an_rgbw_model(fppd):
    """An image entry draws onto an RGBW model with each pixel's colour in
    its RGB channels and white off.

    Regression: 710dd3e5a. The RGB image buffer was handed to the model as
    if it were in the model's own format, four bytes a pixel: the image
    came out garbled, and the copy read a third past the end of the
    buffer.
    """
    setup(fppd, [matrix(cpn=4)], channels=WIDTH * HEIGHT * 4)
    ppm(os.path.join(fppd.media, "images", "Exact.ppm"), WIDTH, HEIGHT, (0, 0, 77))
    fppd.write("playlists/Img.json", {"name": "Img", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": [image_entry("Exact.ppm"), pause(3)],
                                      "leadOut": []})
    want = bytes([0, 0, 77, 0]) * (WIDTH * HEIGHT)
    with DdpReceiver(WIDTH * HEIGHT * 4) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Img", "false", "false")
        time.sleep(2.5)
        frame = rx.last()
    assert frame is not None and frame[:len(want)] == want, frame and frame[:16].hex()


def test_images_of_the_same_name_in_two_folders_are_cached_apart(fppd):
    """Two images both named x.ppm, in different folders, each scaled for
    the model: the second shows its own colour, not the first one's cached
    copy.

    Regression: 1275411aa. The scaled copy was cached under the image's
    base name alone, so the second image found the first one's copy in the
    cache (newer than itself) and drew A's red.
    """
    setup(fppd, [matrix()])
    # The cache folder is made by fppd since 728e00799, after the bug: make
    # it here so the parent caches at all.
    os.makedirs(os.path.join(fppd.media, "cache"), exist_ok=True)
    for folder, rgb in (("A", (66, 0, 0)), ("B", (0, 0, 66))):
        ppm(os.path.join(fppd.media, "images", folder, "x.ppm"), WIDTH * 4, HEIGHT * 4, rgb)
    for name, path, hold in (("PA", "A/x.ppm", 2), ("PB", "B/x.ppm", 8)):
        fppd.write(f"playlists/{name}.json", {"name": name, "repeat": 0, "loopCount": 0,
                                              "leadIn": [], "leadOut": [],
                                              "mainPlaylist": [image_entry(path), pause(hold)]})
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        # One after the other: each entry prepares its image when its
        # playlist loads, so B must load after A has written its copy.
        fppd.command("Start Playlist", "PA", "false", "false")
        fppd.wait_for(lambda: lit_with(rx.last(), (66, 0, 0)), what="image A on the wire")
        idle = lambda: fppd.get("/fppd/status").get("status_name") == "idle"
        fppd.wait_for(idle, what="PA to finish")
        # Before 0fd4fa1d7 a finished playlist's entries were freed by the
        # next playlist's first tick, and freeing PA's image entry while PB
        # drew blanked the model. A short playlist in between takes that
        # tick.
        fppd.write("playlists/PX.json", {"name": "PX", "repeat": 0, "loopCount": 0, "leadIn": [],
                                          "leadOut": [], "mainPlaylist": [pause(1)]})
        fppd.command("Start Playlist", "PX", "false", "false")
        time.sleep(0.5)
        fppd.wait_for(idle, what="PX to finish")
        fppd.command("Start Playlist", "PB", "false", "false")
        try:
            fppd.wait_for(lambda: lit_with(rx.last(), (0, 0, 66)), timeout=6,
                          what="image B on the wire")
        except TimeoutError:
            raise AssertionError(f"image B never showed; the wire has {rx.last()[:12].hex()}")
        fppd.command("Stop Now")


def test_an_image_entry_whose_model_went_away_finishes(fppd):
    """An image entry whose overlay model goes away while the playlist
    plays (the output that made it is saved under another name) finishes,
    and the playlist carries on.

    Regression: 1275411aa. Draw() found no model and returned without
    counting the image as drawn: the entry never finished, the playlist
    stalled on it, and the warning was raised again every tick.
    """
    from show import ddp_output
    from test_overlays import PANEL_CHANNELS, colorlight_panel
    from test_playlist_entries import pause as pause_entry, playlist, step, trace
    fppd.write("config/channeloutputs.json", colorlight_panel("Panel"))
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    ppm(os.path.join(fppd.media, "images", "Exact.ppm"), 32, 16, (0, 0, 77))
    fppd.write("playlists/Img.json", playlist("Img", main=[
        pause_entry(4), dict(image_entry("Exact.ppm"), modelName="Panel"), step(1)]))
    fppd.start()
    models = lambda: [m.get("Name") for m in fppd.get("/models") or []]
    fppd.wait_for(lambda: "Panel" in models(), what="the panel's own model")
    fppd.command("Start Playlist", "Img", "false", "false")
    # Saved as FPP's own writers do, a temporary file renamed over it, in a
    # later second than the first: fppd reloads the outputs, and the model
    # is now "Moved".
    time.sleep(1.1)
    path = fppd.write("config/.channeloutputs.json.tmp", colorlight_panel("Moved"))
    os.replace(path, os.path.join(fppd.media, "config", "channeloutputs.json"))
    fppd.wait_for(lambda: "Panel" not in models(), timeout=10, what="the outputs to reload")
    assert fppd.get("/fppd/status").get("current_playlist", {}).get("type") == "pause", \
        "the outputs reloaded after the pause had ended"
    fppd.wait_for(lambda: trace(fppd) == "1", timeout=15, what="the entry after the image")


def test_a_stopped_image_entry_ends_its_thread(fppd):
    """Stopping a playlist on an image entry ends that entry's image thread
    soon after, not when the next show starts.

    Regression: 0fd4fa1d7. A stopped playlist's entries were freed only by
    the next playlist's Process(), and the main loop runs that only while
    something plays: the image thread (and whatever else the entries held)
    lived on until the next show.
    """
    setup(fppd, [matrix()])
    ppm(os.path.join(fppd.media, "images", "Exact.ppm"), WIDTH, HEIGHT, (0, 0, 77))
    fppd.write("playlists/Img.json", {"name": "Img", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": [image_entry("Exact.ppm"), pause(30)],
                                      "leadOut": []})

    def image_threads():
        n = 0
        for t in os.listdir(f"/proc/{fppd.proc.pid}/task"):
            try:
                with open(f"/proc/{fppd.proc.pid}/task/{t}/comm") as f:
                    n += f.read().strip() == "FPP-ImageLoop"
            except OSError:
                pass
        return n
    fppd.start()
    fppd.command("Start Playlist", "Img", "false", "false")
    fppd.wait_for(image_threads, what="the image entry's thread")
    fppd.command("Stop Now")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "idle", what="the stop")
    fppd.wait_for(lambda: image_threads() == 0, timeout=5,
                  what="the stopped image entry's thread to end")


def test_the_image_cache_is_trimmed_to_its_entry_limit(fppd):
    """A cache folder holding 210 scaled copies ("pei-*.png") is trimmed to
    the cache's 200-entry limit when an image entry loads, oldest first; a
    file in the cache that isn't a scaled copy is left alone.

    Regression: 86901f4da. CleanupCache() was an empty FIXME, so the cache
    folder only ever grew."""
    setup(fppd, [matrix()])
    cache = os.path.join(fppd.media, "cache")
    os.makedirs(cache, exist_ok=True)
    now = time.time()
    for i in range(210):
        p = os.path.join(cache, f"pei-old{i:03d}.png")
        with open(p, "wb") as f:
            f.write(b"\x89PNG not really")
        os.utime(p, (now - 10000 + i, now - 10000 + i))   # pei-old000 the oldest
    with open(os.path.join(cache, "other.txt"), "w") as f:
        f.write("not ours")
    ppm(os.path.join(fppd.media, "images", "Exact.ppm"), WIDTH, HEIGHT, (0, 0, 77))
    frame = show_image(fppd, "Exact.ppm")
    assert lit_with(frame, (0, 0, 77)), frame and frame[:12].hex()
    left = sorted(f for f in os.listdir(cache) if f.startswith("pei-old"))
    assert len(left) == 200, f"{len(left)} cached copies left of 210"
    assert left[0] == "pei-old010.png", f"not the oldest removed: first left is {left[0]}"
    assert os.path.exists(os.path.join(cache, "other.txt"))


def tiff(path, w, h, pixels, orientation):
    """A little-endian uncompressed RGB TIFF with an EXIF-style Orientation
    tag. `pixels` is rows of (r, g, b)."""
    import struct
    data = b"".join(bytes(p) for row in pixels for p in row)
    n = 9
    ifd_at = 8
    ifd_len = 2 + n * 12 + 4
    bits_at = ifd_at + ifd_len            # 3 x SHORT bits-per-sample
    strip_at = bits_at + 6
    entries = [
        (256, 4, 1, w), (257, 4, 1, h), (258, 3, 3, bits_at), (262, 3, 1, 2), (273, 4, 1, strip_at),
        (274, 3, 1, orientation), (277, 3, 1, 3), (278, 4, 1, h), (279, 4, 1, len(data)),
    ]
    out = b"II*\x00" + struct.pack("<I", ifd_at) + struct.pack("<H", n)
    for tag, typ, count, value in entries:
        out += struct.pack("<HHI", tag, typ, count) + (struct.pack("<HH", value, 0) if typ == 3 and count == 1
                                                      else struct.pack("<I", value))
    out += struct.pack("<I", 0) + struct.pack("<HHH", 8, 8, 8) + data
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(out)


def test_an_image_turned_by_its_exif_orientation_is_drawn_upright(fppd):
    """A picture stored 5 across and 10 down with an orientation of 6 (turn
    it a quarter clockwise to see it) is drawn on a 10 by 5 model upright:
    the red corner stored top left shows at the top right.

    Regression: 2c70e53be. The orientation was ignored, so a phone photo
    came out on its side."""
    setup(fppd, [matrix()])
    red, green = (255, 0, 0), (0, 255, 0)
    pixels = [[green] * 5 for _ in range(10)]
    pixels[0][0] = red
    tiff(os.path.join(fppd.media, "images", "Phone.tif"), 5, 10, pixels, orientation=6)
    frame = show_image(fppd, "Phone.tif")
    assert frame is not None
    top_right = (0 * WIDTH + WIDTH - 1) * 3
    assert frame[top_right:top_right + 3] == bytes(red), frame[:WIDTH * 3].hex()
    assert frame[0:3] == bytes(green), frame[:6].hex()


def png(path, w, h, rgb):
    import struct
    import zlib

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = (b"\0" + bytes(rgb) * w) * h
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def test_a_cached_copy_of_the_wrong_size_is_not_scaled_again(fppd):
    """When the cached copy of an image is not the model's size, the entry
    goes back to the original file instead of scaling the cached copy.

    Regression: cdfaca38d. A cached copy of another size was taken as the
    starting point and scaled a second time, so the image was drawn from an
    already-scaled picture, not the original. (The copy here is a different
    colour, so a draw from it shows.)
    """
    setup(fppd, [matrix()])
    ppm(os.path.join(fppd.media, "images", "Big.ppm"), WIDTH * 4, HEIGHT * 4, (66, 0, 0))
    fppd.write("playlists/Img.json", {"name": "Img", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": [image_entry("Big.ppm"), pause(6)],
                                      "leadOut": []})
    idle = lambda: fppd.get("/fppd/status").get("status_name") == "idle"
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Img", "false", "false")
        fppd.wait_for(lambda: lit_with(rx.last(), (66, 0, 0)), what="the first draw")
        fppd.command("Stop Now")
        fppd.wait_for(idle, what="the playlist to stop")
        cache = os.path.join(fppd.media, "cache")
        copies = [f for f in os.listdir(cache) if f.startswith("pei-Big.ppm-")]
        assert len(copies) == 1, copies
        # The copy for this model, replaced by one of another size and colour.
        png(os.path.join(cache, copies[0]), WIDTH * 2, HEIGHT * 2, (0, 66, 0))
        # A short playlist in between takes the tick that frees the first
        # one's image entry, which would blank the model under the second
        # draw (see the two-folders test).
        fppd.write("playlists/PX.json", {"name": "PX", "repeat": 0, "loopCount": 0, "leadIn": [],
                                          "leadOut": [], "mainPlaylist": [pause(1)]})
        fppd.command("Start Playlist", "PX", "false", "false")
        time.sleep(0.5)
        fppd.wait_for(idle, what="PX to finish")
        again = time.monotonic()
        fppd.command("Start Playlist", "Img", "false", "false")
        time.sleep(3)
        # The model still shows the first draw until the second one lands,
        # so look at the last frame and for any frame of the planted colour.
        assert not any(lit_with(d, (0, 66, 0)) for t, d in rx.snapshot(since=again)), \
            "the cached copy was scaled again"
        assert lit_with(rx.last(), (66, 0, 0)), f"the wire has {rx.last()[:12].hex()}"
        fppd.command("Stop Now")


def test_image_entries_on_one_folder_pick_in_their_own_order(fppd):
    """Several image entries naming the same folder do not all pick the
    same file: each starts its random choice from its own seed.

    Regression: 602e7e559. Every entry seeded from the clock alone, so
    entries created in the same second chose the same files in the same
    order and played in lock-step.
    """
    setup(fppd, [matrix()])
    for i in range(12):
        ppm(os.path.join(fppd.media, "images", "Set", f"img{i:02d}.ppm"), WIDTH, HEIGHT, (0, 0, 20 + i))
    entries = [image_entry("Set") for _ in range(6)]
    fppd.write("playlists/Img.json", {"name": "Img", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": entries + [pause(30)], "leadOut": []})
    fppd.start()
    fppd.command("Start Playlist", "Img", "false", "false")
    time.sleep(4)
    cfg = fppd.get("/fppd/playlist/config")
    names = [e.get("imageFilename") for e in cfg.get("mainPlaylist", []) if e.get("type") == "image"]
    assert len(names) == 6 and all(names), names
    assert len(set(names)) > 1, f"all six entries drew {names[0]}"
    fppd.command("Stop Now")
