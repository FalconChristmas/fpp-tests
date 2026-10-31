"""Pixel overlays: channel ranges, models, submodels and their effects,
driven through the overlay API and checked on the wire."""

import json
import os
import threading
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


def test_a_rejected_model_is_not_blamed_on_memory(fppd):
    """A model definition fppd rejects is logged with what was wrong with
    it, and not also as a failure to allocate memory.

    Regression: 5a31620e3. Every model dropped at load was logged "could
    not allocate memory", after the line giving the real reason."""
    setup(fppd, [matrix("ZeroStart", start=0), dict(matrix("Negative"), StringCount=-5),
                 matrix("Good", start=31, width=2, height=2)])
    fppd.start()
    assert "Good" in [m["Name"] for m in fppd.get("/overlays/models")]
    blamed = [l for l in fppd.log().splitlines() if "could not allocate memory" in l]
    assert not blamed, "a rejected model was blamed on memory:\n" + "\n".join(blamed)


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


def test_a_wled_effect_with_more_arguments_than_it_has_is_run_on_the_ones_it_has(fppd):
    """A WLED effect started with extra trailing arguments uses the ones it
    has slots for and ignores the rest, and the model still works.

    Regression: ec480f0cb. The argument loop ran to the end of the
    caller's list and indexed the effect's argument map past its end."""
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        desc = fppd.get("/overlays/effects/" + urllib.parse.quote("WLED - Colorloop"))
        args = [a.get("default", "") for a in desc["args"]] + ["junk"] * 40
        fppd.command("Overlay Model Effect", "M", "Enabled", "WLED - Colorloop", *args)
        time.sleep(1)
        fppd.check_alive()
        stop_effects(fppd, "M")
        effect_done(fppd, "M")
        fill(fppd, "M", [0, 0, 77])
        wait_output(fppd, rx, lambda f: f[2] == 77, "the model to fill afterwards")


def test_custom_model_nodes_past_its_channels_are_disabled(fppd):
    """A custom model whose layout names a node beyond the model's channel
    count draws its real nodes and leaves that one out, saying so in the
    log.

    Regression: 4ef8481e0. channelMap took the node numbers as given while
    the model's channel data is exactly its channel count, so drawing wrote
    megabytes past it.

    Also 1746fddbb: custom layout node numbers are 1-based, and node n was
    mapped to node n+1's channels, so every node drew one place along.

    Also 59b6f7aa0: a node's three channels were at y*3+x, not at
    (y*width + x)*3, so on a model of more than one row they overlapped
    their neighbours' and the nodes never all filled."""
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


def font_files():
    """The names (file name less its extension) of the font files fppd
    searches for: TrueType and Type 1 under the system font folders."""
    names = set()
    for root in ("/usr/share/fonts/truetype", "/usr/share/fonts/X11/Type1", "/usr/local/share/fonts"):
        for _, _, files in os.walk(root):
            names |= {f[:-4] for f in files if f.endswith((".ttf", ".pfb"))}
    return names


def test_a_text_effect_naming_a_font_that_is_not_installed_is_refused(fppd):
    """A Text effect whose Font is not one installed here is refused, with a
    warning naming the font, and the model still fills afterwards. Every
    font the font list offers is one with a font file behind it.

    Regression: 4713c35a2. An unknown name was handed on to GraphicsMagick
    as if it were a font file, and the font list also carried every name
    GraphicsMagick's type list knew whether or not its file was installed,
    so the picker offered fonts that could only fail like that."""
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        try:
            effect(fppd, "M", "Text", Font="No-Such-Font", Text="hi", Duration="1")
            refused = False
        except urllib.error.HTTPError:
            refused = True
        warned = [w for w in fppd.get("/fppd/warnings") if "Could not find font 'No-Such-Font'" in w]
        assert refused and warned, f"refused: {refused}, warnings: {fppd.get('/fppd/warnings')}"
        unbacked = sorted(set(fppd.get("/overlays/fonts")) - font_files())
        assert not unbacked, f"{len(unbacked)} listed fonts have no font file: {unbacked[:8]}"
        fill(fppd, "M", [0, 0, 66])
        wait_output(fppd, rx, lambda f: f[2] == 66, "the model to fill afterwards")


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

    Coverage for 021b1d200 (removal freed the model while those callers
    still held it after dropping the models lock) and 0a3840413 (its effect
    leaked); the two tests below are what fail without them."""
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


def test_an_output_reload_during_an_image_put_to_its_model(fppd):
    """An image PUT to an output's own model decodes without the models
    lock; the outputs reloaded meanwhile remove that model, and the PUT
    still draws into it safely afterwards.

    Regression: 021b1d200. Removal deleted the model outright, so the PUT
    blitted into freed memory. PUTs of a large image back to back spend
    nearly all their time decoding, so each reload lands inside one."""
    import http.client
    from fppd import API
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    side = 3000
    png = rgb_png(side, side, bytes([0, 40, 0]) * (side * side))
    stop = threading.Event()
    answers = []

    def put_images():
        host, port = urllib.parse.urlsplit(API).netloc.split(":")
        while not stop.is_set():
            try:
                conn = http.client.HTTPConnection(host, int(port), timeout=30)
                conn.request("PUT", "/overlays/model/Panel/data?fmt=image&stopEffect=false", body=png,
                             headers={"Content-Type": "image/png"})
                answers.append(conn.getresponse().status)
                conn.close()
            except Exception:
                time.sleep(0.01)

    fppd.start()
    fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                  what="the panel's own model")
    t = threading.Thread(target=put_images, daemon=True)
    t.start()
    try:
        fppd.wait_for(lambda: answers, timeout=30, what="the first image PUT")
        for _ in range(4):
            resave_outputs(fppd)
    finally:
        stop.set()
        t.join(60)
    assert 200 in answers, f"no image PUT succeeded: {sorted(set(answers))}"


def test_an_output_reload_frees_the_effect_running_on_its_model(fppd):
    """An effect running on an output's own model when the outputs are
    reloaded goes with the model: LeakSanitizer finds nothing an effect
    allocated left behind.

    Regression: 0a3840413. ~PixelOverlayModel never deleted the running
    effect, so each reload leaked it."""
    from fppd import sanitizer
    from native_plugin import install
    if sanitizer() != "asan":
        pytest.skip("needs LeakSanitizer (an ASan build)")
    install(fppd, features=["NATIVE_LEAKCHECK"])
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    # fppd is not leak-clean, so leaks are written apart from the reports the
    # fixture fails on, and only the effects' are counted here.
    lsan = os.path.join(fppd.media, "logs", "lsan")
    fppd.start(extra_env={"ASAN_OPTIONS": (
        f"halt_on_error=1:detect_leaks=1:abort_on_error=0:log_path={lsan}")})
    fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                  what="the panel's own model")
    for _ in range(3):
        effect(fppd, "Panel", "Bars")
        resave_outputs(fppd)
    found = fppd.command("Native Test Leak Check", timeout=60)
    assert found in ("leaks", "clean"), found
    leaks = ""
    if found == "leaks":
        with open(f"{lsan}.{fppd.proc.pid}", errors="replace") as f:
            leaks = f.read()
    ours = [b for b in leaks.split("\n\n") if "PixelOverlayModel::applyEffect" in b]
    assert not ours, "the reloads leaked their effects:\n" + "\n\n".join(ours)[:6000]


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


def test_a_submodel_left_enabled_across_an_output_reload(fppd):
    """A submodel of an output's own model, left enabled and drawing while
    the outputs are saved (re-creating its parent), stops drawing through
    the old parent, and filled again draws into the new one.

    Regression: 3914f4b77. Recreating the output freed the parent model
    with the submodel still enabled in it, and the channel output thread
    went on drawing the submodel through its pointer to the freed parent."""
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
        for n in range(3):
            resave_outputs(fppd)
            time.sleep(0.5)  # frames through the old parent, if it is still used
            fill(fppd, "Corner", [0, 0, 20 + n])
            wait_output(fppd, rx, lambda f: f[2] == 20 + n, "the submodel to fill the new parent")
        keeps_sending(rx)


def test_retired_auto_model_freed_late_leaves_its_replacement_alone(fppd):
    """An output's own model kept alive past an output reload (a playlist
    image entry holds it until its next draw) is freed without touching
    the model that replaced it: the replacement's shared memory stays
    linked, and its submodel, enabled again after the reload, stays
    enabled. Two rounds.

    Regression: fbd28f211. The retired model's destructor acted on its
    name: it shm_unlink()ed /FPP-Model-Data-Panel, which the replacement
    had attached to, and reset every submodel in its child list by name,
    so the replacement's submodel was disabled. That reset also took
    modelsLock, which a submodel's setState() on the effect thread reaches
    holding the submodel's effectLock (the reverse lock order)."""
    hold = 3
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": [
        submodel("Corner", "Panel", 0, 0, 4, 2)]})
    fppd.settings(DisableFakeNetworkBridges="1")
    os.makedirs(os.path.join(fppd.media, "images"), exist_ok=True)
    with open(os.path.join(fppd.media, "images", "Panel.ppm"), "wb") as f:
        f.write(b"P6\n32 16\n255\n" + bytes((0, 5, 0)) * (32 * 16))
    fppd.write("playlists/Img.json", {
        "name": "Img", "repeat": 1, "loopCount": 0, "leadIn": [], "leadOut": [],
        "mainPlaylist": [
            {"type": "image", "enabled": 1, "playOnce": 0, "modelName": "Panel",
             "imagePath": "Panel.ppm"},
            {"type": "pause", "enabled": 1, "playOnce": 0, "duration": hold}]})
    shm = "/dev/shm/FPP-Model-Data-Panel"

    def corner_state():
        m = [x for x in fppd.get("/overlays/models") if x.get("Name") == "Corner"]
        return m[0].get("isActive") if m else None

    with DdpReceiver(PANEL_CHANNELS):
        fppd.start()
        fppd.wait_for(lambda: "Panel" in [m.get("Name") for m in fppd.get("/models") or []],
                      what="the panel's own model")
        fill(fppd, "Corner", [0, 0, 11])  # Corner is in the panel's child list
        fppd.command("Start Playlist", "Img", "true", "false")
        time.sleep(1)  # the image is drawn; the entry holds the panel model
        for round in range(2):
            resave_outputs(fppd)  # retires the panel model and resets Corner
            fill(fppd, "Corner", [0, 0, 12 + round])  # into the new panel model
            fppd.wait_for(lambda: corner_state() == 1, what="Corner enabled again")
            assert os.path.exists(shm), f"round {round + 1}: no {shm} after the reload"
            # The entry draws again and drops the retired model.
            time.sleep(hold + 1.5)
            assert corner_state() == 1, \
                f"round {round + 1}: freeing the retired model disabled the new model's submodel"
            assert os.path.exists(shm), \
                f"round {round + 1}: freeing the retired model unlinked the new model's {shm}"
            fill(fppd, "Corner", [0, 0, 11])  # back in the new panel's child list


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


def test_an_image_under_the_pixel_floor_is_capped_by_a_small_boards_ram(fppd):
    """On a 512 MB board, a 4 KB PNG of 5792x5792 (33.5M pixels, just under
    32*1024*1024) is refused, or decoded without the memory for it: fppd's
    peak memory grows by well under the 256 MB that 33.5M pixels of 8-byte
    pixel cache take. The shim makes fppd see 512 MB of RAM.

    Regression: eb0986756. The GraphicsMagick pixel cap, meant to be a
    quarter of RAM in pixel cache (16M pixels at 512 MB), was clamped up to a
    32M-pixel floor whatever the RAM, so this file took about 300 MB, an OOM
    kill on a BeagleBone or PocketBeagle 2."""
    import shims
    setup(fppd, [matrix()])
    png = huge_png(5792, 5792)
    assert 5792 * 5792 < 32 * 1024 * 1024
    fppd.start(preload=[shims.build("fakemem.c")], extra_env={"FAKEMEM_MB": "512"})
    before = peak_rss_mb(fppd.proc.pid)
    try:
        put(fppd, "model/M/data?fmt=image", png, timeout=60)
    except urllib.error.HTTPError:
        pass  # refused is the point
    grew = peak_rss_mb(fppd.proc.pid) - before
    assert grew < 150, f"fppd's peak memory grew {grew} MB decoding a {len(png) // 1024} KB image"


def test_submodel_effect_ending_during_output_reloads(fppd):
    """A submodel whose effect ends and disables it (Stop Effects), over and
    over, while the outputs reload and re-create its parent, never touches
    the freed parent.

    Regression: 5611e0bae. The submodel's setState() read its cached parent
    with no lock from the effect and output threads, while the reload freed
    the parent under modelsLock.

    Also guards 34d1b9bf5 under TSan: a model's state was written by the
    reload's resetParent() while the effect thread read it. Proved by
    reverting it on 0ec85d6ae (its parent has other races): red 4 of 4."""
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


def test_submodel_effect_end_reaches_its_parent_while_models_are_busy(fppd):
    """A submodel whose Text effect ends (and disables it, having enabled
    it) while other overlay commands keep modelsLock busy still leaves its
    parent's child list: the sequence playing underneath shows through the
    submodel's corner again.

    Regression: cbc2e6b83. 5611e0bae try-locked modelsLock for about 20 ms
    around a submodel's setState() and, when it stayed busy, changed the
    submodel's own state but skipped telling its parent. Here a wide Text
    render on another model holds modelsLock for its whole render, back to
    back from three HTTP threads, while the submodel's effect ends on the
    effect thread. The parent kept the disabled submodel as an enabled
    child, stayed active, and painted the corner black over the sequence."""
    import threading
    from fseq import solid_frames
    from show import install
    install(fppd, solid_frames(1200, CHANNELS, 33))  # 60 s
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        matrix(), submodel("Corner", "M", 0, 0, 2, 2),
        matrix("Busy", start=1001, width=PANEL_W, height=PANEL_H)]})
    corner = list(range(0, 6)) + list(range(30, 36))
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Show", "true", "false")
        wait_output(fppd, rx, lambda f: f[0] == 33, "the sequence to play")
        font = a_font(fppd)
        desc = fppd.get("/overlays/effects/Text")

        def text_args(**overrides):
            return [overrides.get(a["name"], a.get("default", "")) for a in desc["args"]]
        wide = text_args(Font=font, FontSize="36", Position="Right to Left", Speed="200",
                         Text="".join(chr(ord("A") + i % 26) for i in range(2500)))
        short = text_args(Font=font, FontSize="8", Position="Center", Duration="1", Text="X")

        stuck = []
        for rnd in range(5):
            stop = threading.Event()

            def hammer():
                while not stop.is_set():
                    fppd.command("Overlay Model Effect", "Busy", "Enabled", "Text", *wide, timeout=60)
            threads = [threading.Thread(target=hammer, daemon=True) for _ in range(3)]
            for t in threads:
                t.start()
            try:
                time.sleep(0.5)
                fppd.command("Overlay Model Effect", "Corner", "Enabled", "Text", *short, timeout=60)
                fppd.wait_for(lambda: not [m for m in fppd.get("/overlays/models")
                                           if m.get("Name") == "Corner" and m.get("effectRunning")],
                              timeout=30, what="the submodel's effect to end")
                time.sleep(0.5)
            finally:
                stop.set()
                for t in threads:
                    t.join(timeout=60)
            time.sleep(0.5)
            if any(rx.last()[c] != 33 for c in corner):
                stuck.append(rnd)
            fppd.command("Overlay Model State", "M", "Disabled")
            fppd.command("Overlay Model State", "Busy", "Disabled")
            time.sleep(0.3)
        assert not stuck, (f"rounds {stuck} of 5: the submodel's corner stayed over the "
                           "sequence after the submodel's effect disabled it")


def test_text_too_big_to_scroll_is_refused_without_the_memory(fppd):
    """A scrolling Text effect whose strip would be tens of millions of
    pixels (3000 characters at FontSize 100, some 280000x120) is refused
    with a log line, without GraphicsMagick allocating the strip, and the
    model it auto-enabled is disabled again.

    Regression: 371ab1ae7. The scrolling path renders the whole message
    onto one strip whose size was the caller's to choose: this one took
    hundreds of MB (8 bytes a pixel, then an RGB copy), more than a
    BeagleBone has."""
    channels = PANEL_W * PANEL_H * 3
    setup(fppd, [matrix("Panel", width=PANEL_W, height=PANEL_H)], channels=channels)
    fppd.start()
    desc = fppd.get("/overlays/effects/Text")
    overrides = dict(Font=a_font(fppd), FontSize="100", Position="Right to Left", Text="W" * 3000)
    args = [overrides.get(a["name"], a.get("default", "")) for a in desc["args"]]
    before = peak_rss_mb(fppd.proc.pid)
    try:
        fppd.command("Overlay Model Effect", "Panel", "Enabled", "Text", *args, timeout=60)
    except urllib.error.HTTPError as e:  # refused is right
        print(f"the effect answered {e.code}")
    time.sleep(2)
    grew = peak_rss_mb(fppd.proc.pid) - before
    assert grew < 128, f"fppd's peak memory grew {grew} MB rendering the text strip"
    assert "over the 4194304 pixel limit" in fppd.log()
    m = [x for x in fppd.get("/overlays/models") if x.get("Name") == "Panel"]
    assert m and m[0].get("isActive") == 0, f"the model was left enabled: {m}"


def test_overlay_commands_exist_with_no_models(fppd):
    """With no overlay models at all, the overlay commands are registered,
    once each, and a fill of a model that doesn't exist reaches the
    command.

    Regression: 41f1af083. The commands were registered by addModel() when
    it added the first model, so a player with no models (or one where a
    model listener had already put an empty entry in the map) never had
    them."""
    setup(fppd, [])
    fppd.start()
    names = [c.get("name") for c in fppd.get("/commands")]
    for n in ("Overlay Model Effect", "Overlay Model Fill", "Overlay Model State"):
        assert names.count(n) == 1, f"{n!r} is registered {names.count(n)} times"
    try:
        reply = fppd.command("Overlay Model Fill", "Nothing", "Enabled", "#FF0000")
    except urllib.error.HTTPError as e:
        reply = e.body
    assert "No model found" in str(reply), reply


def test_stop_effects_does_not_stall_the_output(fppd):
    """Stopping a model's effect doesn't hold up the output: the frames on
    the wire keep their cadence through the stop.

    Regression: 9762c46d5. Stop Effects blanks the model and disables it
    after the next output, on the output thread itself; disabling waited up
    to 100 ms for the model's buffer, just blanked, to be flushed -- by the
    output thread, which was the one waiting. Every such stop held the
    output for the whole 100 ms.
    """
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        rounds = []
        for _ in range(5):
            effect(fppd, "M", "Bars")
            wait_output(fppd, rx, lambda f: any(f), "the bars")
            since = time.monotonic()
            rx.wait_frames(10, since=since)
            stop_effects(fppd, "M")
            effect_done(fppd, "M")
            time.sleep(0.3)
            t = [when for when, _ in rx.snapshot(since=since)]
            gaps = sorted(b - a for a, b in zip(t, t[1:]))
            rounds.append((gaps[len(gaps) // 2], gaps[-1]))  # cadence, worst
        print("cadence, largest gap per stop (ms):",
              [(round(c * 1000), round(w * 1000)) for c, w in rounds])
        # The stall is 100 ms on every stop; one late frame is scheduling.
        stalled = [r for r in rounds if r[1] > r[0] + 0.045]
        assert len(stalled) <= 1, \
            f"{len(stalled)} of {len(rounds)} stops held the output: {stalled}"


def test_set_value_sets_the_channels_it_is_given(fppd):
    """A plugin's PixelOverlayModel::setValue() sets the absolute channels
    it names, clamped to the model, or all of the model's for -1, -1.

    Regression: 61553e67d. setValue() looked the channels up in channelMap
    (laid out by buffer cell) by channel number, worked out the end from its
    own start argument, and made an omitted end a bound that set two
    channels: a whole-model set lit two, a range lit the wrong one.
    """
    from native_plugin import install
    install(fppd, features=["NATIVE_SETVALUE"])
    model = matrix(start=31, width=4, height=2)  # channels 30-53, 0-based
    setup(fppd, [model])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        put(fppd, "model/M/state", {"State": 1})
        assert fppd.command("Native Test Set Value", "M", "200", "-1", "-1") == "set"
        wait_output(fppd, rx, lambda f: f[30:54] == bytes([200] * 24),
                    "the whole model at 200", timeout=5)
        assert fppd.command("Native Test Set Value", "M", "7", "40", "42") == "set"
        assert fppd.command("Native Test Set Value", "M", "9", "50", "1000") == "set"
        want = bytes(30) + bytes([200] * 10 + [7] * 3 + [200] * 7 + [9] * 4) + bytes(CHANNELS - 54)
        wait_output(fppd, rx, lambda f: f == want, "the ranges, and nothing past the model",
                    timeout=5)


def test_a_bulk_pixel_put_whose_size_wraps_32_bits_is_refused(fppd):
    """PUT .../data with a width and height whose product overflows 32
    bits, and a body as long as the wrapped product, is refused; the model
    and fppd carry on.

    Regression: 66df390e2 (32-bit builds; on 64-bit the check never
    wrapped). w=1073741825, h=4, mono came to 4 bytes in a 32-bit size_t, a
    4-byte body passed, and the blit stepped a gigabyte through the request
    per row: on a BeagleBone Black the request never came back.
    """
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        with pytest.raises(urllib.error.HTTPError) as e:
            put(fppd, "model/M/data?w=1073741825&h=4&fmt=mono", bytes([255] * 4))
        assert e.value.code == 400, f"answered {e.value.code}"
        fill(fppd, "M", [0, 0, 5])
        wait_output(fppd, rx, lambda f: f[2] == 5, "a fill after the refused put")


TW, TH = 48, 24


def text_setup(fppd):
    """A TW x TH model M, enabled, with output; return a plain font."""
    setup(fppd, [matrix(width=TW, height=TH)], channels=TW * TH * 3)
    fppd.start()
    fppd.command("Overlay Model State", "M", "Enabled")
    fonts = fppd.get("/overlays/fonts")
    if not fonts:
        pytest.skip("no fonts installed")
    return next((f for f in fonts if f.lower() in ("dejavusans", "dejavu-sans")), fonts[0])


def settled_rows(fppd, rx, what):
    """The rows lit on the wire once the frames are lit and stop changing."""
    seen = []

    def still():
        f = rx.last()
        seen.append(f)
        return f is not None and any(f) and seen[-3:] == [f] * 3
    fppd.wait_for(still, timeout=10, interval=0.1, what=what)
    f = seen[-1]
    return [y for y in range(TH) if any(f[y * TW * 3:(y + 1) * TW * 3])]


def bands(rows):
    """Runs of consecutive rows."""
    runs = []
    for y in rows:
        if runs and y == runs[-1][-1] + 1:
            runs[-1].append(y)
        else:
            runs.append([y])
    return runs


def still_text(fppd, font, msg):
    effect(fppd, "M", "Text", Color="#FFFFFF", Font=font, FontSize="10",
           Position="Center", Text=msg)


def test_a_typed_line_break_splits_the_text(fppd):
    """A "\\n" typed into the text (backslash, n) starts a second line: the
    ink is two bands of rows with a blank row between them.

    Regression: b83d8b62d. The text was drawn as one line, the backslash
    and the n with it."""
    font = text_setup(fppd)
    with DdpReceiver(TW * TH * 3) as rx:
        still_text(fppd, font, "HH")
        one = bands(settled_rows(fppd, rx, "one line"))
        assert len(one) == 1, f"one line drew {len(one)} bands"
        still_text(fppd, font, "HH\\nHH")
        two = bands(settled_rows(fppd, rx, "two lines"))
        assert len(two) == 2, f"\"HH\\nHH\" drew rows {two}, not two lines"


def test_a_doubled_backslash_keeps_a_literal_backslash_n(fppd):
    """A doubled backslash is one literal backslash, so "c:\\\\network"
    stays one line rather than breaking at its "\\n".

    Regression: 383f106dd. Only "\\n" was translated: the first backslash
    went through as itself and the second, with the n, broke the line."""
    font = text_setup(fppd)
    with DdpReceiver(TW * TH * 3) as rx:
        still_text(fppd, font, "HH\\\\nHH")
        rows = bands(settled_rows(fppd, rx, "the text"))
        assert len(rows) == 1, f"\"HH\\\\nHH\" broke into rows {rows}"


def test_the_legacy_text_command_draws_its_text(fppd):
    """The hidden "Overlay Model Text" command, kept for presets and MQTT
    topics saved before the effects, still draws its text.

    Regression: 5e5eaf360. It built the argument list "Overlay Model
    Effect" takes and then passed on its own instead, so the colour was
    read as the state and the font as the effect: nothing was drawn."""
    font = text_setup(fppd)
    with DdpReceiver(TW * TH * 3) as rx:
        fppd.command("Overlay Model Text", "M", "#00FF00", font, "10", "false",
                     "Center", "0", "true", "HH")
        wait_output(fppd, rx, lambda f: any(f[1::3]) and not any(f[0::3]),
                    "green text on the wire")


def test_an_effect_ending_on_a_parentless_submodel_while_models_are_listed(fppd):
    """An effect ending on a submodel whose parent can't be found, while
    clients list the models, doesn't wedge fppd.

    Regression: c0c70183d. The effect ends on the output thread, under the
    submodel's effect lock, by disabling it; an unresolved parent was then
    looked up under modelsLock. Listing the models takes modelsLock and
    then each model's effect lock: the two waited on each other, and output
    and the API stopped. (The listing walks many models here, so that
    modelsLock is held most of the time.)
    """
    others = [matrix(f"P{i:03d}", start=1 + 3 * i, width=1, height=1) for i in range(200)]
    orphan = submodel("Orphan", "NoSuchParent", 0, 0, 2, 2)
    setup(fppd, others + [orphan], channels=600)
    fppd.start()
    stop = time.monotonic() + 15
    errors = []

    def lister():
        while time.monotonic() < stop and not errors:
            try:
                fppd.get("/overlays/models", timeout=10)
            except Exception as e:  # reported below
                errors.append(e)
    threads = [threading.Thread(target=lister) for _ in range(3)]
    for t in threads:
        t.start()
    fades = 0
    try:
        while time.monotonic() < stop and not errors:
            effect(fppd, "Orphan", "Color Fade", Color="#00FF00", fadeIn="0", fadeOut="0")
            fades += 1
            time.sleep(0.05)
    finally:
        stop = 0
        for t in threads:
            t.join()
    assert not errors, f"after {fades} fades: {errors[0]}"
    print(f"{fades} fades")


def rgb_png(width, height, pixels):
    """A PNG of width x height RGB pixels, row-major."""
    import struct
    import zlib

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))
    rows = b"".join(b"\0" + bytes(pixels[y * width * 3:(y + 1) * width * 3]) for y in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def raw_data(model="M"):
    from fppd import API
    import urllib.request
    with urllib.request.urlopen(f"{API}/overlays/model/{model}/data/raw", timeout=10) as r:
        return r.read()


def test_bulk_pixel_data_in_and_out(fppd):
    """A whole frame of pixels goes into a model in one PUT .../data -- as
    raw bytes, as a region hanging off the model's edge (clipped), as
    base64 in JSON, or as a PNG -- and comes back from GET .../data/raw.

    Feature: a17126050 (before it, neither endpoint existed)."""
    w, h = 4, 2
    setup(fppd, [matrix(width=w, height=h)])
    fppd.start()
    frame = bytes(range(10, 10 + w * h * 3))
    put(fppd, "model/M/data", frame)
    assert raw_data() == frame, "the raw frame did not read back"

    # 2x2 at (3,1): only its top-left pixel lands on the model.
    put(fppd, "model/M/data?x=3&y=1&w=2&h=2", bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))
    want = bytearray(frame)
    want[(1 * w + 3) * 3:(1 * w + 3) * 3 + 3] = bytes([1, 2, 3])
    assert raw_data() == bytes(want), "the clipped region read back wrong"

    import base64
    put(fppd, "model/M/data", {"X": 0, "Y": 0, "W": 1, "H": 1, "Format": "rgb",
                               "Data": base64.b64encode(bytes([7, 8, 9])).decode()})
    want[0:3] = bytes([7, 8, 9])
    assert raw_data() == bytes(want), "the base64 JSON pixel read back wrong"

    pixels = [200, 0, 0] * (w * h // 2) + [0, 0, 200] * (w * h // 2)
    put(fppd, "model/M/data?fmt=image&scale=none", rgb_png(w, h, pixels))
    assert raw_data() == bytes(pixels), "the PNG read back wrong"


def test_an_rgbw_fill_takes_an_explicit_white(fppd):
    """Overlay Model Fill with #RRGGBBWW on an RGBW model puts the white
    value in each node's W channel.

    Regression: ce0f4efcd. The colour was read as a 24-bit #RRGGBB number,
    so its top byte was lost and the rest moved up a channel: R got G, G
    got B, B got W, and W was 0."""
    channels = WIDTH * HEIGHT * 4
    setup(fppd, [matrix("W", cpn=4)], channels=channels)
    with DdpReceiver(channels) as rx:
        fppd.start()
        fppd.command("Overlay Model Fill", "W", "Enabled", "#11223344")
        wait_output(fppd, rx, lambda f: any(f), "the fill on the wire")
        keeps_sending(rx)
        assert rx.last() == bytes([0x11, 0x22, 0x33, 0x44]) * (WIDTH * HEIGHT), \
            f"first node: {list(rx.last()[:4])}"


def test_a_models_colour_order_is_its_channel_data_order(fppd):
    """A model reports the order of fppd's channel data for its node width
    (RGB, RGBW), whatever ColorOrder its saved definition carries: the
    output applies the wire's order, so a model with its own would have it
    applied twice by anything that honoured it.

    Regression: 6ecdcd275. A saved ColorOrder was kept and reported as the
    model's."""
    channels = WIDTH * HEIGHT * 7
    setup(fppd, [dict(matrix("A"), ColorOrder="GRB"),
                 dict(matrix("B", start=WIDTH * HEIGHT * 3 + 1, cpn=4), ColorOrder="WGRB")],
          channels=channels)
    fppd.start()
    orders = {m["Name"]: m.get("ColorOrder") for m in fppd.get("/overlays/models")}
    assert orders == {"A": "RGB", "B": "RGBW"}, orders


def test_a_wled_effect_on_an_rgbw_model_drives_the_white_channel(fppd):
    """A WLED effect drawn in white on an RGBW model lights each node's W
    channel with the white the RGB share (min of R, G and B), and writes
    nothing past the model.

    Regression: afc15745a. WLED's bus said it had no white channel, so
    every RGBW node's W stayed 0 and white was R+G+B alone."""
    nodes = WIDTH * HEIGHT
    channels = nodes * 4 + 12
    setup(fppd, [matrix("W", cpn=4)], channels=channels)
    with DdpReceiver(channels) as rx:
        fppd.start()
        effect(fppd, "W", "WLED - Android", brightness="255", palette="* Color 1",
               color1="#FFFFFF", color2="#FFFFFF")
        wait_output(fppd, rx, lambda f: any(f), "the effect on the wire")
        since = time.monotonic()
        rx.wait_frames(20, since=since)
        frames = [f for _, f in rx.snapshot(since=since)]
        lit = [f[i:i + 4] for f in frames for i in range(0, nodes * 4, 4) if any(f[i:i + 3])]
        assert lit, "the effect lit no node"
        wrong = [list(n) for n in lit if n[3] != min(n[:3])]
        assert not wrong, f"{len(wrong)} of {len(lit)} lit nodes' W is not min(R,G,B): {wrong[:5]}"
        assert all(f[nodes * 4:] == bytes(12) for f in frames), "wrote past the model"


def test_a_parentless_submodel_shown_while_states_change(fppd):
    """A submodel whose parent can't be found, enabled, while clients
    switch other models on and off for 20 s: every request is answered and
    the output keeps going.

    Regression: 37c8f92a8. The output thread resolved a submodel's parent
    from doOverlay(), taking modelsLock under activeModelsLock, every frame
    while it stayed unresolved; a state change takes the two the other way
    round. The two threads waited on each other, and every overlay route
    hung from then on (in about 12 s here)."""
    others = [matrix(f"S{i}", start=1 + 3 * i, width=1, height=1) for i in range(8)]
    setup(fppd, others + [submodel("Orphan", "NoSuchParent", 0, 0, 2, 2)], channels=60)
    with DdpReceiver(60) as rx:
        fppd.start()
        fill(fppd, "Orphan", [0, 0, 9])
        stop = time.monotonic() + 20
        errors = []

        def toggle(names):
            on = 0
            while time.monotonic() < stop and not errors:
                on ^= 1
                for n in names:
                    try:
                        put(fppd, f"model/{n}/state", {"State": on})
                    except Exception as e:  # reported below
                        errors.append(e)
                        return
        threads = [threading.Thread(target=toggle, args=([m["Name"] for m in others[i::4]],))
                   for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors, errors[0]
        keeps_sending(rx)


def test_a_custom_model_with_a_blank_or_text_node_still_draws_its_real_nodes(fppd):
    """A custom model whose layout has a blank cell, a cell holding a space and
    one holding text draws its numbered nodes and leaves the others dark.

    Regression: 604f2a395. A cell that was a space or not a number reached
    std::stoi, which throws: the model's constructor threw out of the
    overlay manager and the model (and fppd's start) went with it."""
    custom = {"Name": "C", "Type": "Channel", "StartChannel": 1, "ChannelCount": 9,
              "ChannelCountPerNode": 3, "Orientation": "custom", "StartCorner": "TL",
              "StringCount": 1, "StrandsPerString": 1, "data": "1, ,3;a,2"}
    setup(fppd, [custom])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fill(fppd, "C", [0, 0, 55])
        wait_output(fppd, rx, lambda f: f[:9] == bytes([0, 0, 55] * 3), "the custom model's three nodes to fill")
        keeps_sending(rx)


def test_a_custom_model_is_capped_at_600_by_600_nodes(fppd):
    """Layers of a custom model that would take it past 600 x 600 nodes are
    dropped (the first layer is kept), so a layout cannot ask for more
    memory than a small board has.

    Regression: b010b392e. The model grew to whatever its data asked for."""
    wide = ",".join(["1"] * 700)
    layers = "1,2,3|" + ";".join([wide] * 600)
    custom = {"Name": "C", "Type": "Channel", "StartChannel": 1, "ChannelCount": 9,
              "ChannelCountPerNode": 3, "Orientation": "custom", "StartCorner": "TL",
              "StringCount": 1, "StrandsPerString": 1, "data": layers}
    setup(fppd, [custom])
    fppd.start()
    assert "C" in [m["Name"] for m in fppd.get("/overlays/models")], "the capped model was not loaded"
    size = len(raw_data("C"))
    assert size <= 600 * 600 * 3, f"the model took the layers past the cap: {size} bytes of pixels"


def test_a_model_with_a_pixel_size_of_zero_loads(fppd):
    """A framebuffer model saved with PixelSize 0 (and no such device) does
    not take fppd down at start: its pixel size is ignored, not divided by.

    Regression: 9dd99ba4b. Width / PixelSize was a division by zero (SIGFPE
    at start) for a model saved with no pixel size."""
    display = {"Name": "D", "Type": "FB", "Width": 20, "Height": 10, "PixelSize": 0, "Device": "fb9"}
    setup(fppd, [display, matrix()])
    fppd.start()
    assert "M" in [m["Name"] for m in fppd.get("/overlays/models")]


@pytest.mark.parametrize("x, y", [(500, 0), (0, 500), (-1, 0), (0, -1), (2147483647, 2147483647)])
def test_a_pixel_outside_the_model_is_ignored(fppd, x, y):
    """Setting a pixel at a position outside the model changes nothing and
    leaves fppd running.

    Regression: 89b96100e. The position was turned into a channel index
    unchecked, and written to."""
    setup(fppd, [matrix(width=4, height=2)])
    fppd.start()
    before = raw_data()
    try:
        put(fppd, "model/M/pixel", {"X": x, "Y": y, "RGB": [1, 2, 3]})
    except urllib.error.HTTPError:
        pass
    assert raw_data() == before, "a pixel outside the model changed it"
    put(fppd, "model/M/pixel", {"X": 0, "Y": 0, "RGB": [9, 8, 7]})
    assert raw_data()[:3] == bytes([9, 8, 7]), "fppd stopped taking pixels"


def test_the_all_models_choice_is_offered_only_when_asked_for(fppd):
    """GET /models?simple=true&all=true lists "--All Models--" first, ahead
    of the models, which is what the Overlay Model Effect command's model
    picker asks for; without all=true the list is the model names alone.

    Feature: 8082e6962."""
    setup(fppd, [matrix()])
    fppd.start()
    assert fppd.get("/models?simple=true&all=true") == ["--All Models--", "M"]
    assert fppd.get("/models?simple=true") == ["M"]


def test_the_full_effects_list_has_each_effects_description(fppd):
    """GET /overlays/effects lists the names; with full=true, each effect's
    description (its args) in the same order, and "Stop Effects" is
    first.

    Regression: 1d301eabd (the flag added) and b32972050 (Stop Effects at
    the head of the list)."""
    setup(fppd, [matrix()])
    fppd.start()
    names = fppd.get("/overlays/effects")
    full = fppd.get("/overlays/effects?full=true", timeout=60)
    assert names[0] == "Stop Effects", names[:3]
    assert len(full) == len(names)
    assert all(isinstance(d, dict) for d in full) and all("args" in d for d in full[1:]), full[:2]
    one = fppd.get("/overlays/effects/" + urllib.parse.quote(names[1]))
    assert full[1] == one, "the full list's entry is not the effect's own description"


def test_bars_and_text_take_their_numbers_as_ranges(fppd):
    """The Bars (iterations, colorRep, colors) and Text (FontSize, Speed)
    arguments are ranges with limits, which the effect picker shows as
    sliders, not free integers.

    Regression: b32972050."""
    setup(fppd, [matrix()])
    fppd.start()

    def kinds(effect):
        return {a["name"]: a["type"] for a in fppd.get("/overlays/effects/" + effect)["args"]}
    bars, text = kinds("Bars"), kinds("Text")
    assert [bars[k] for k in ("iterations", "colorRep", "colors")] == ["range"] * 3, bars
    assert [text[k] for k in ("FontSize", "Speed")] == ["range"] * 2, text


def test_wled_effects_take_their_defaults_from_the_effects_own_settings(fppd):
    """A WLED effect's arguments default to what WLED gives that effect, not
    128 and the first palette: Aurora's speed is 24 and its palette Aurora;
    Fire 2012's cooling is 64 and its palette Fire.

    Regression: 4e2418c73."""
    setup(fppd, [matrix()])
    fppd.start()

    def defaults(effect):
        return {a["name"]: a.get("default") for a in fppd.get("/overlays/effects/" + urllib.parse.quote(effect))["args"]}
    aurora, fire = defaults("WLED - Aurora"), defaults("WLED - Fire 2012")
    assert (aurora["Speed"], aurora["palette"]) == ("24", "Aurora"), aurora
    assert (fire["Cooling"], fire["palette"]) == ("64", "Fire"), fire
