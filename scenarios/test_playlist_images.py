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
