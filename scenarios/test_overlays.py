"""Pixel overlays: channel ranges, models, submodels and their effects,
driven through the overlay API and checked on the wire."""

import json
import os
import time
import urllib.error
import urllib.parse

import pytest

from ddp import DdpReceiver
from show import ddp_output

CHANNELS = 150
WIDTH, HEIGHT = 10, 5


def matrix(name="M", start=1, width=WIDTH, height=HEIGHT, cpn=3):
    """A width x height model, one row per string, from channel `start`."""
    return {"Name": name, "Type": "Channel", "StartChannel": start,
            "ChannelCount": width * height * cpn, "ChannelCountPerNode": cpn,
            "Orientation": "horizontal", "StartCorner": "TL",
            "StringCount": height, "StrandsPerString": 1}


def submodel(name, parent, x, y, w, h):
    """A rectangle of `parent`, as the UI's Sub model dialog saves it."""
    return {"Name": name, "Type": "Sub", "Parent": parent,
            "XOffset": x, "YOffset": y, "Width": w, "Height": h,
            "StartChannel": 1, "ChannelCount": w * h * 3, "ChannelCountPerNode": 3,
            "Orientation": "horizontal", "StartCorner": "TL",
            "StringCount": h, "StrandsPerString": 1}


def setup(fppd, models=(), channels=CHANNELS):
    """A DDP output of `channels` to this machine, and the given models."""
    fppd.write("config/co-universes.json", ddp_output(channels))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": list(models)})
    fppd.settings(DisableFakeNetworkBridges="1")


def put(fppd, path, body, timeout=10):
    return fppd.request("PUT", "/overlays/" + path, body, timeout=timeout)


def fill(fppd, model, rgb):
    """Enable `model` and fill it, through the Fill command."""
    return fppd.command("Overlay Model Fill", model, "Enabled",
                        "#%02X%02X%02X" % tuple(rgb))


def effect(fppd, model, name, **overrides):
    """Run an overlay effect with its declared defaults, except `overrides`
    (by argument name)."""
    desc = fppd.get("/overlays/effects/" + urllib.parse.quote(name))
    args = [overrides.get(a["name"], a.get("default", "")) for a in desc["args"]]
    return fppd.command("Overlay Model Effect", model, "Enabled", name, *args)


def stop_effects(fppd, model, timeout=10):
    return fppd.command("Overlay Model Effect", model, "Enabled", "Stop Effects",
                        timeout=timeout)


def wait_output(fppd, rx, check, what, timeout=10):
    """Wait until the latest frame on the wire satisfies `check`."""
    return fppd.wait_for(lambda: rx.last() is not None and check(rx.last()),
                         timeout=timeout, interval=0.05, what=what)


def keeps_sending(rx, frames=20, what="output"):
    since = time.monotonic()
    rx.wait_frames(frames, timeout=10, since=since)
    assert rx.count(since) >= frames, f"{what} stopped"


def test_range_past_the_end_of_the_channel_data_is_refused(fppd):
    """A channel range overlay that runs past the end of fppd's channel data
    is refused; a valid one next to it still lights.

    Regression: 8a63fbc50. The range was stored unchecked, and the output
    thread wrote every channel of it into the sequence buffer on each frame:
    8388600-9000000 overwrote the heap past the buffer on the next frame.
    """
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        try:
            put(fppd, "range/8388600-9000000", {"Value": 255})
        except urllib.error.HTTPError as e:  # refused is right
            print(f"bad range answered {e.code}")
        put(fppd, "range/1-10", {"Value": 200})
        wait_output(fppd, rx, lambda f: f[:10] == bytes([200] * 10),
                    "the valid range to reach the wire")
        keeps_sending(rx, 40)
        assert rx.last()[10:] == bytes(CHANNELS - 10)


def test_deleting_a_range_that_was_never_set_lights_nothing(fppd):
    """Deleting a range that isn't active leaves its channels dark.

    Regression: 9962405fa. A delete of an unknown range inserted it with the
    value -1, stored as 0xFF, so asking for the channels to go dark forced
    them full on.
    """
    setup(fppd)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        put(fppd, "range/1-10", {"Value": 50})
        wait_output(fppd, rx, lambda f: f[:10] == bytes([50] * 10),
                    "the first range to reach the wire")
        put(fppd, "range/21-30/delete", None)
        keeps_sending(rx)
        frame = rx.last()
        assert frame[20:30] == bytes(10), f"deleting an unset range lit it: {list(frame[20:30])}"
        assert frame[:10] == bytes([50] * 10)


def test_fill_over_http_reaches_the_wire(fppd):
    """PUT /api/overlays/model/<m>/fill with an RGB colour lights the model.

    Regression: 4e4acbe2b. fill() wrote the colour straight into the
    model's channels, then the handler flushed the overlay buffer, which
    allocated one -- all zeros -- and copied it over the fill. The request
    answered OK and the model went black.
    """
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        put(fppd, "model/M/state", {"State": 1})
        put(fppd, "model/M/fill", {"RGB": [10, 20, 30]})
        wait_output(fppd, rx, lambda f: f == bytes([10, 20, 30]) * (WIDTH * HEIGHT),
                    "the filled model on the wire")


@pytest.mark.parametrize("args, what", [
    ({"colors": "0"}, "no colours"),
    ({"colors": "9"}, "more colours than it has arguments for"),
    ({"iterations": "100000000"}, "a hundred million iterations"),
])
def test_bars_effect_survives_any_arguments(fppd, args, what):
    """The Bars effect clamps its arguments instead of trusting them, and the
    overlay API keeps answering while it runs.

    Regression: aef7cbdd7. Num Colors 0 read the first colour of an empty
    list; more than five read arguments past the end; a huge iteration count
    left a float loop that never ended, holding the effect lock, so the next
    overlay request wedged.
    """
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect(fppd, "M", "Bars", Direction="Down", **args)
        keeps_sending(rx, what=f"output with {what}")
        # Other overlay requests have to get through while the effect runs.
        fppd.get("/overlays/running", timeout=5)
        stop_effects(fppd, "M", timeout=5)
        fppd.get("/overlays/model/M/clear", timeout=5)


def test_submodel_that_is_its_own_parent_is_refused(fppd):
    """A submodel whose parent chain leads back to itself never draws, and
    the rest of the overlays keep running.

    Regression: 2c98ba8cb. Drawing a submodel draws into its parent, which
    re-dirtied the child; with the child as its own parent (the UI's Parent
    list offers the model itself) or two submodels parenting each other, the
    output thread recursed until the stack overflowed.
    """
    setup(fppd, [matrix(), submodel("Self", "Self", 0, 0, 2, 2),
                 submodel("A", "B", 0, 0, 2, 2), submodel("B", "A", 0, 0, 2, 2)])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        for name in ("Self", "A", "B"):
            try:
                fill(fppd, name, [255, 0, 0])
            except urllib.error.HTTPError as e:  # refusing the model is right
                print(f"{name}: {e.code}")
        fill(fppd, "M", [0, 0, 77])
        wait_output(fppd, rx, lambda f: f[2] == 77, "the parent model's fill to reach the wire")
        keeps_sending(rx)


def test_colour_names_are_read_in_any_case(fppd):
    """A fill colour given as a name in any case ("Red") fills with that
    colour.

    Regression: 919ff8391. mapColor() knew ten lowercase names and handed
    anything else to stoul, which threw: the fill did nothing over HTTP, and
    from an MQTT topic or the effect thread the throw was uncaught.
    """
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Overlay Model Fill", "M", "Enabled", "Red")
        wait_output(fppd, rx, lambda f: f[:6] == bytes([255, 0, 0, 255, 0, 0]),
                    "the model to fill red")


def test_bad_model_definitions_do_not_stop_fppd_starting(fppd):
    """fppd starts with a model-overlays.json holding definitions it can't
    represent, drops those, and drives the good model.

    Regression: 6998005b5. The model constructor trusted the file, which
    POST /api/models wrote unchecked: a wrong-typed field threw out of
    startup (a crash on every boot), StartChannel 0 wrote one channel before
    the channel buffer every frame, and a negative size threw from resize().
    """
    bad = [
        dict(matrix("TextStart"), StartChannel="one"),
        dict(matrix("ObjectName"), Name={"x": 1}),
        matrix("ZeroStart", start=0),
        dict(matrix("Negative"), StringCount=-5),
        matrix("PastTheEnd", start=8388600),
    ]
    setup(fppd, bad + [matrix("Good", start=31, width=2, height=2)])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        for m in bad:
            if isinstance(m["Name"], str):
                try:
                    fill(fppd, m["Name"], [9, 9, 9])
                except urllib.error.HTTPError as e:  # a dropped model isn't there
                    print(f"{m['Name']}: {e.code}")
        fill(fppd, "Good", [1, 2, 3])
        wait_output(fppd, rx, lambda f: f[30:42] == bytes([1, 2, 3] * 4),
                    "the good model to reach the wire")
        keeps_sending(rx)


def test_post_models_refuses_a_body_it_could_not_load(fppd):
    """POST /api/models with "models" that is not a list of objects is
    refused, and the file on disk is left as it was.

    Regression: 6998005b5. The body was written to model-overlays.json
    unchecked, and fppd crashed on every start after.
    """
    setup(fppd, [matrix()])
    fppd.start()
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.post("/models", {"models": {"Name": "x"}})
    assert e.value.code == 400
    with open(os.path.join(fppd.media, "config", "model-overlays.json")) as f:
        assert json.load(f)["models"][0]["Name"] == "M"


def test_saving_a_model_image_stays_in_the_images_folder(fppd):
    """Saving a model as an image refuses a file name with a directory part.

    Regression: e17e043ce. The name was appended to the images directory
    unchecked, so "../" walked out of it; fppd runs as root on a device.
    """
    setup(fppd, [matrix()])
    fppd.start()
    fill(fppd, "M", [10, 20, 30])
    try:
        put(fppd, "model/M/save", {"File": "../escaped.png"})
    except urllib.error.HTTPError as e:  # refused is right
        print(f"save answered {e.code}")
    put(fppd, "model/M/save", {"File": "inside.png"})
    fppd.wait_for(lambda: os.path.exists(os.path.join(fppd.media, "images", "inside.png")),
                  timeout=5, what="a plain file name to save")
    assert not os.path.exists(os.path.join(fppd.media, "escaped.png")), \
        "the image was written outside the images folder"


def test_submodel_of_an_rgbw_model_keeps_its_colours(fppd):
    """Filling a submodel of an RGBW model puts each colour in its own
    channel of each RGBW node.

    Regression: 62c7716e9. The submodel's buffer is 3 bytes a node and its
    parent read it 4 at a time: every colour after the first node shifted,
    and the read ran a third past the end of the submodel's buffer.
    """
    channels = WIDTH * HEIGHT * 4
    setup(fppd, [matrix("W", cpn=4), submodel("Corner", "W", 0, 0, 4, 1)], channels=channels)
    with DdpReceiver(channels) as rx:
        fppd.start()
        fill(fppd, "Corner", [10, 20, 30])
        wait_output(fppd, rx, lambda f: any(f), "the submodel to reach the wire")
        keeps_sending(rx)
        frame = rx.last()
        assert frame[:16] == bytes([10, 20, 30, 0]) * 4, f"first row: {list(frame[:16])}"
        assert frame[16:] == bytes(channels - 16)


PANEL_W, PANEL_H = 32, 16


def run_scrolling_text(fppd, text, **start):
    channels = PANEL_W * PANEL_H * 3
    setup(fppd, [matrix("Panel", width=PANEL_W, height=PANEL_H)], channels=channels)
    with DdpReceiver(channels) as rx:
        fppd.start(**start)
        effect(fppd, "Panel", "WLED - Scrolling Text", Text=text)
        wait_output(fppd, rx, lambda f: any(f), "the text to draw")
        keeps_sending(rx, 60, "output while the text scrolled")
        stop_effects(fppd, "Panel")


def test_long_scrolling_text_message(fppd):
    """The WLED Scrolling Text effect scrolls a 240-character message.

    Regression: 0c9f8b8f9. The message was copied into a 65-byte stack array
    with no bound, every frame, on the overlay effect thread; the bytes past
    64 were the sender's to choose.
    """
    run_scrolling_text(fppd, "".join(chr(ord("A") + i % 26) for i in range(240)))


def test_scrolling_text_date_tokens_late_in_the_month(fppd):
    """Scrolling Text's date tokens draw on the 15th of the month.

    Regression: 3231c71bd. #DAY and #DDDD indexed the 8-entry day-name table
    with the day of the month, so from the 8th on sprintf got a pointer from
    past the end of the table.
    """
    run_scrolling_text(fppd, "#DAY #DDDD #MON #MMMM #YYYY",
                       fake_time="2026-10-15 12:00:00")
