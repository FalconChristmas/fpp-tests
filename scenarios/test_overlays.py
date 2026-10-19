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


def effect_done(fppd, model, timeout=10):
    """Wait until `model` has no running effect. Stop Effects is itself an
    effect: it blanks and disables the model a frame or two later, undoing
    a fill that lands before then."""
    def done():
        m = [x for x in fppd.get("/overlays/models") if x.get("Name") == model]
        return m and not m[0].get("effectRunning")
    fppd.wait_for(done, timeout=timeout, what=f"{model}'s effect to finish")


def a_font(fppd):
    fonts = fppd.get("/overlays/fonts")
    if not fonts:
        pytest.skip("no fonts installed")
    return fonts[0]


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


def test_effect_with_too_few_arguments_is_refused(fppd):
    """An effect command naming a model and an effect but none of the
    effect's arguments is refused, and the model still works.

    Regression: a8fe562b1. Every effect indexes its argument vector
    positionally, so an empty one segfaulted fppd -- from one well-formed
    HTTP request."""
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        for name in ("Bars", "Color Fade", "Text", "WLED - Colorloop"):
            try:
                fppd.command("Overlay Model Effect", "M", "Enabled", name)
            except urllib.error.HTTPError:
                pass  # refused
        fill(fppd, "M", [0, 0, 66])
        wait_output(fppd, rx, lambda f: f[2] == 66, "the model to fill afterwards")


def test_custom_model_nodes_past_its_channels_are_disabled(fppd):
    """A custom model whose layout names a node beyond the model's channel
    count draws its real nodes and leaves that one out, saying so in the
    log.

    Regression: 4ef8481e0. channelMap took the node numbers as given while
    the model's channel data is exactly its channel count, so drawing wrote
    megabytes past it."""
    custom = {"Name": "C", "Type": "Channel", "StartChannel": 1, "ChannelCount": 9,
              "ChannelCountPerNode": 3, "Orientation": "custom", "StartCorner": "TL",
              "StringCount": 1, "StrandsPerString": 1, "data": "1,2;3,2800000"}
    setup(fppd, [custom])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fill(fppd, "C", [0, 0, 55])
        wait_output(fppd, rx, lambda f: f[:9] == bytes([0, 0, 55] * 3), "the custom model's nodes to fill")
        keeps_sending(rx)
    assert "exceed the model's 9 channels and were disabled" in fppd.log()


def test_submodel_outside_its_parent_is_skipped(fppd):
    """A submodel that lies outside its parent (saved before the parent
    shrank) is skipped, and the parent still draws.

    Regression: 4322cc5d0. The child's rectangle indexed the parent's
    channel map every frame with no bound, reading far past it and, for an
    opaque child, writing through what it found."""
    setup(fppd, [matrix(), submodel("Out", "M", 300, 200, 40, 40)])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        try:
            fill(fppd, "Out", [255, 255, 255])
        except urllib.error.HTTPError:
            pass
        time.sleep(0.5)
        fill(fppd, "M", [0, 0, 44])
        wait_output(fppd, rx, lambda f: f[2] == 44, "the parent to fill")
        keeps_sending(rx)


def test_unknown_effect_and_font_lookups_add_nothing(fppd):
    """Asking for an effect or font that doesn't exist doesn't add it: the
    effect and font lists are what they were, and the full effect list
    (every effect's description) still builds.

    Regression: 430e5879b. Both lookups used std::map::operator[], which
    inserted an empty entry for every name not found."""
    setup(fppd, [matrix()])
    fppd.start()
    effects = fppd.get("/overlays/effects")
    try:
        fppd.get("/overlays/effects/No%20Such%20Effect")
    except urllib.error.HTTPError:
        pass
    try:
        effect(fppd, "M", "Text", Font="No-Such-Font", Text="hi", Duration="1")
    except urllib.error.HTTPError:
        pass  # refused for want of the font, after looking it up
    time.sleep(1)
    assert "No Such Effect" not in fppd.get("/overlays/effects")
    assert len(fppd.get("/overlays/effects?full=true")) == len(effects)
    assert "No-Such-Font" not in fppd.get("/overlays/fonts")


def test_fonts_in_subdirectories_are_listed(fppd):
    """The font list includes the TrueType fonts installed in per-family
    directories (truetype/dejavu and the like), which is where Debian puts
    every one of them.

    Regression: 2b27ed08a. Entries without a dot in their name were
    skipped before the directory check, so no family directory was ever
    searched."""
    root = "/usr/share/fonts/truetype"
    nested = set()
    for d, _, files in os.walk(root):
        if d != root:
            nested |= {f[:-4] for f in files if f.lower().endswith(".ttf")}
    if not nested:
        pytest.skip("no TrueType fonts in a family directory here")
    setup(fppd, [matrix()])
    fppd.start()
    listed = set(fppd.get("/overlays/fonts"))
    assert nested & listed, f"none of {sorted(nested)[:5]}... listed"


PANEL_CHANNELS = 32 * 16 * 3


def colorlight_panel(description="Panel"):
    """One 32x16 ColorLight panel on lo: an output that creates its own
    overlay model (named after the description), with no hardware."""
    return {"channelOutputs": [{
        "type": "LEDPanelMatrix", "subType": "ColorLight5a75", "enabled": 1,
        "startChannel": 1, "channelCount": PANEL_CHANNELS, "description": description,
        "interface": "lo", "linkCheck": False, "panelWidth": 32, "panelHeight": 16,
        "cfgVersion": 2, "colorOrder": "RGB",
        "panels": [{"outputNumber": 0, "panelNumber": 0, "xOffset": 0, "yOffset": 0,
                    "orientation": "N", "colorOrder": "RGB"}]}]}


def resave_outputs(fppd):
    """Save channeloutputs.json as FPP's own writers do (a temporary file
    renamed over it) and wait for fppd to reload the outputs, which removes
    the panel's model and creates it again."""
    marker = "Loading output plugin: type=ColorLight5a75"
    before = fppd.log().count(marker)
    time.sleep(1.1)  # a save in a later second
    path = fppd.write("config/.channeloutputs.json.tmp", colorlight_panel())
    os.replace(path, os.path.join(fppd.media, "config", "channeloutputs.json"))
    fppd.wait_for(lambda: fppd.log().count(marker) > before, timeout=15, interval=0.25,
                  what="the outputs to reload")
    fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                  what="the panel's model back after the reload")


def test_auto_model_in_use_survives_an_output_reload(fppd):
    """An output's own model, in use from other threads -- an effect
    running on it, its pixels written through the bulk PUT, the
    running-effects list read -- survives the outputs being saved under it
    again and again.

    Regression: 021b1d200. Removal freed the model while those callers
    still held it after dropping the models lock (and 0a3840413: its effect
    leaked)."""
    import http.client
    import threading
    from fppd import API
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    stop = threading.Event()
    pixels = bytes(range(256)) * (PANEL_CHANNELS // 256) + bytes(PANEL_CHANNELS % 256)

    def hammer(method, path, body):
        # One kept-alive connection per thread: a request every few ms, so
        # one is in flight whenever a reload frees the model.
        host, port = urllib.parse.urlsplit(API).netloc.split(":")
        conn = None
        while not stop.is_set():
            try:
                if conn is None:
                    conn = http.client.HTTPConnection(host, int(port), timeout=5)
                conn.request(method, path, body=body,
                             headers={"Content-Type": "application/octet-stream"})
                conn.getresponse().read()
            except Exception:
                conn = None  # a 404 or a dropped connection mid-reload is fine
                time.sleep(0.01)

    jobs = [("GET", "/overlays/running", None)] * 4 + \
        [("PUT", "/overlays/model/Panel/data?stopEffect=false&autoEnable=true", pixels)] * 2
    with DdpReceiver(PANEL_CHANNELS) as rx:
        fppd.start()
        fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                      what="the panel's own model")
        threads = [threading.Thread(target=hammer, args=j, daemon=True) for j in jobs]
        for t in threads:
            t.start()
        try:
            for _ in range(20):
                effect(fppd, "Panel", "Bars")
                resave_outputs(fppd)
        finally:
            stop.set()
            for t in threads:
                t.join(10)
        stop_effects(fppd, "Panel")
        effect_done(fppd, "Panel")
        fill(fppd, "Panel", [0, 0, 22])
        wait_output(fppd, rx, lambda f: f[2] == 22, "the panel model to fill afterwards")


def test_submodel_of_a_reloaded_auto_model(fppd):
    """A submodel of an output's own model, enabled and disabled, then the
    outputs saved (re-creating the parent), then enabled again, draws into
    the new parent.

    Regression: ef95c5a67. The disabled submodel kept a pointer to the
    freed parent and drew through it."""
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": [
        submodel("Corner", "Panel", 0, 0, 4, 2)]})
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(PANEL_CHANNELS) as rx:
        fppd.start()
        fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                      what="the panel's own model")
        fill(fppd, "Corner", [0, 0, 11])
        wait_output(fppd, rx, lambda f: f[2] == 11, "the submodel to fill")
        fppd.command("Overlay Model State", "Corner", "Disabled")
        resave_outputs(fppd)
        time.sleep(0.5)
        fill(fppd, "Corner", [0, 0, 12])
        wait_output(fppd, rx, lambda f: f[2] == 12, "the submodel to fill again")
        keeps_sending(rx)


@pytest.mark.parametrize("gap", [0, 5])
def test_stop_effects_on_an_idle_model_is_not_left_pending(fppd, gap):
    """Stop Effects on a model that is disabled (nothing running, or an
    effect that already ended) finishes at once, and a fill afterwards --
    straight away or seconds later -- stays.

    Regression: f815eccb2. The stop was queued to run after the next
    output pass, which an idle fppd never makes: it sat on the model and
    blanked and disabled whatever next enabled it."""
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        stop_effects(fppd, "M")
        effect_done(fppd, "M", timeout=5)
        time.sleep(gap)
        fill(fppd, "M", [0, 0, 77])
        wait_output(fppd, rx, lambda f: f[2] == 77, "the fill to reach the wire")
        time.sleep(1)
        assert rx.last()[2] == 77, "the fill was undone"


def test_shutdown_with_an_auto_models_submodel_enabled(fppd):
    """fppd shuts down cleanly with a submodel of an output's own model
    enabled, and its channel output thread stays stopped once shutdown
    has stopped it.

    Regression: ba12850b7. Closing the outputs at shutdown removes the
    panel's model, which resets its enabled submodel; that state change
    started the output thread again, and it ran on into the deleted
    sequence (heap-use-after-free in Sequence::hasBridgeData)."""
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": [
        submodel("Corner", "Panel", 0, 0, 4, 2)]})
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(PANEL_CHANNELS) as rx:
        fppd.start()
        fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                      what="the panel's own model")
        fill(fppd, "Corner", [0, 0, 11])
        wait_output(fppd, rx, lambda f: f[2] == 11, "the submodel to fill")
        rc = fppd.stop()
        fppd.exit_expected = True
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    log = fppd.log()
    stopped = log.rfind("Stopping channel output thread.")
    assert stopped >= 0, "fppd never got to stopping its output thread"
    assert "Channel output thread running" not in log[stopped:], \
        "the channel output thread was started again after shutdown stopped it"
    assert rc == 0, f"fppd exited {rc}"


def running_effect(fppd, model):
    m = [x for x in fppd.get("/overlays/models") if x.get("Name") == model]
    return m[0].get("effectName") if m and m[0].get("effectRunning") else None


def test_fill_straight_after_stop_effects_stays(fppd):
    """On a lit model, Stop Effects and then at once a Fill: the fill is
    the newer instruction, and it stays.

    Regression: b6015c565. The stop blanks and disables the model a
    frame after it is asked for, and a fill didn't cancel it, so a
    stop-then-fill in a playlist came out dark."""
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect(fppd, "M", "Bars")
        wait_output(fppd, rx, lambda f: any(f), "the bars")
        stop_effects(fppd, "M")
        fill(fppd, "M", [0, 0, 88])
        time.sleep(1)
        assert rx.last()[:6] == bytes([0, 0, 88] * 2), "the fill after Stop Effects was undone"
        assert running_effect(fppd, "M") is None


@pytest.mark.parametrize("how", ["command", "http"])
def test_fill_ends_a_running_effect(fppd, how):
    """A fill on a model with an effect running ends the effect, which
    would otherwise draw over the fill on its next update -- as the bulk
    pixel PUT already did.

    Regression: b6015c565."""
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect(fppd, "M", "Bars")
        wait_output(fppd, rx, lambda f: any(f), "the bars")
        if how == "command":
            fill(fppd, "M", [0, 0, 99])
        else:
            put(fppd, "model/M/fill", {"RGB": [0, 0, 99]})
        time.sleep(1)
        assert running_effect(fppd, "M") is None, "the effect kept running"
        assert rx.last()[:6] == bytes([0, 0, 99] * 2), "the effect drew over the fill"


def test_a_state_change_leaves_a_running_effect_running(fppd):
    """Changing a model's state (say to Transparent) while an effect runs
    on it doesn't end the effect: only drawing over the model does."""
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        effect(fppd, "M", "Bars")
        wait_output(fppd, rx, lambda f: any(f), "the bars")
        fppd.command("Overlay Model State", "M", "Transparent")
        time.sleep(1)
        assert running_effect(fppd, "M") == "Bars"


def huge_png(width, height):
    """A tiny grayscale PNG whose header claims width x height: all-zero rows
    compress to almost nothing."""
    import struct
    import zlib

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))
    z = zlib.compressobj(9)
    row = b"\0" * (width + 1)
    idat = b"".join(z.compress(row) for _ in range(height)) + z.flush()
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def peak_rss_mb(pid):
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) // 1024
    return 0


def test_an_image_claiming_a_huge_size_is_refused_without_the_memory(fppd):
    """An image PUT to a model whose header claims 30000x30000 is refused
    without GraphicsMagick allocating for it.

    Regression: e3e4e471a. The ?w=/&h= clamp only bounds the box the image is
    scaled into after decoding; the decode itself allocated whatever the
    header asked for, 4+ GB for this ~1 MB file, and on a Pi or BeagleBone
    the OOM killer took fppd."""
    setup(fppd, [matrix()])
    bomb = huge_png(30000, 30000)
    fppd.start()
    before = peak_rss_mb(fppd.proc.pid)
    try:
        put(fppd, "model/M/data?fmt=image", bomb, timeout=60)
    except urllib.error.HTTPError:
        pass  # refused is the point
    grew = peak_rss_mb(fppd.proc.pid) - before
    assert grew < 512, f"fppd's peak memory grew {grew} MB decoding a {len(bomb) // 1024} KB image"
    fill(fppd, "M", [1, 2, 3])


def test_submodel_effect_ending_during_output_reloads(fppd):
    """A submodel whose effect ends and disables it (Stop Effects), over and
    over, while the outputs reload and re-create its parent, never touches
    the freed parent.

    Regression: 5611e0bae. The submodel's setState() read its cached parent
    with no lock from the effect and output threads, while the reload freed
    the parent under modelsLock."""
    import threading
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": [
        submodel("Corner", "Panel", 0, 0, 4, 2)]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                  what="the panel's own model")
    stop = threading.Event()

    def churn():
        while not stop.is_set():
            try:
                fill(fppd, "Corner", [0, 0, 9])
                stop_effects(fppd, "Corner")
            except Exception:
                time.sleep(0.01)  # 404 mid-reload is fine

    t = threading.Thread(target=churn, daemon=True)
    t.start()
    try:
        for _ in range(12):
            resave_outputs(fppd)
    finally:
        stop.set()
        t.join(10)


def test_text_wider_than_16384_pixels_scrolls(fppd):
    """A Text effect whose message renders wider than 16384 pixels (a long
    scrolling banner, well inside the effect's own 4M pixel bound) draws.

    Regression: 3cac81783. e3e4e471a capped every GraphicsMagick image at
    16384 pixels wide or high, which also applies to the images fppd makes
    itself: the Text effect draws the whole message as one strip, so the
    strip failed to allocate, doText() logged "could not render text" and
    nothing was drawn."""
    channels = PANEL_W * PANEL_H * 3
    setup(fppd, [matrix("Panel", width=PANEL_W, height=PANEL_H)], channels=channels)
    text = "".join(chr(ord("A") + i % 26) for i in range(3000))
    with DdpReceiver(channels) as rx:
        fppd.start()
        effect(fppd, "Panel", "Text", Font=a_font(fppd), FontSize="12", Position="Right to Left",
               Speed="200", Text=text)
        try:
            wait_output(fppd, rx, lambda f: any(f), "the text to draw", timeout=15)
        finally:
            errors = [l for l in fppd.log().splitlines() if "Text Overlay Effect" in l]
        assert not errors, errors
        keeps_sending(rx, 20, "output while the text scrolled")
        stop_effects(fppd, "Panel")
