"""The overlay model an LED panel output creates for itself (Auto-create
Pixel Overlay Models): what it is named, and that it goes when the output
does.

A ColorLight panel on lo stands in for the panel outputs: it creates its
model in Init() and needs no hardware. BBBMatrix, BBShiftPanel, RGBMatrix
and FBMatrix do the same, in the same words.
"""

import os
import time

PANEL_CHANNELS = 32 * 16 * 3
MARKER = "Loading output plugin: type=ColorLight5a75"


def colorlight_panel(enabled=1, **over):
    """One 32x16 ColorLight panel on lo, as the LED Panels page saves it."""
    c = {"type": "LEDPanelMatrix", "subType": "ColorLight5a75", "enabled": enabled,
         "startChannel": 1, "channelCount": PANEL_CHANNELS, "interface": "lo",
         "linkCheck": False, "panelWidth": 32, "panelHeight": 16, "cfgVersion": 2,
         "colorOrder": "RGB",
         "panels": [{"outputNumber": 0, "panelNumber": 0, "xOffset": 0, "yOffset": 0,
                     "orientation": "N", "colorOrder": "RGB"}]}
    c.update(over)
    return {"channelOutputs": [c]}


def model_names(fppd):
    return sorted(m.get("Name") for m in fppd.get("/models") or [])


def save_outputs(fppd, cfg):
    """Save channeloutputs.json as FPP's own writers do (a temporary file
    renamed over it), in a later second than the last save."""
    time.sleep(1.1)
    path = fppd.write("config/.channeloutputs.json.tmp", cfg)
    os.replace(path, os.path.join(fppd.media, "config", "channeloutputs.json"))


def start(fppd, cfg):
    fppd.write("config/channeloutputs.json", cfg)
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()


def test_a_panel_outputs_model_goes_when_the_output_is_closed(fppd):
    """The panel output's own model ("Panel", from its description) is
    removed when the outputs are reloaded: saving the same config again
    leaves one "Panel" and no "Panel-1", and saving it disabled leaves no
    model at all.

    Regression: d41cdc48f. Close() never removed the model it created, so
    each reload left the old one behind (pointing at the closed output's
    channels) and the new output, finding the name taken, made "Panel-1";
    disabling the output kept "Panel" for good.
    """
    start(fppd, colorlight_panel(description="Panel"))
    fppd.wait_for(lambda: model_names(fppd) == ["Panel"], what=f"the panel's model (have {model_names(fppd)})")
    before = fppd.log().count(MARKER)
    save_outputs(fppd, colorlight_panel(description="Panel"))
    fppd.wait_for(lambda: fppd.log().count(MARKER) > before, timeout=15, what="the outputs to reload")
    fppd.wait_for(lambda: "Panel" in model_names(fppd), what="the model back after the reload")
    time.sleep(1)
    assert model_names(fppd) == ["Panel"], model_names(fppd)
    save_outputs(fppd, colorlight_panel(enabled=0, description="Panel"))
    fppd.wait_for(lambda: model_names(fppd) == [], timeout=15,
                  what=f"the disabled output's model to go (have {model_names(fppd)})")


def test_a_panel_outputs_model_is_named_after_the_matrix(fppd):
    """A matrix saved with a name (the page's Panel Matrix name,
    LEDPanelMatrixName) and no description gets a model of that name; a
    description, when there is one, still wins.

    Regression: d91ed7389. The name was ignored, so every panel output's
    model was "LED Panels" (and the next one "LED Panels-1").
    """
    start(fppd, colorlight_panel(LEDPanelMatrixName="Wall"))
    fppd.wait_for(lambda: model_names(fppd), what="the panel's model")
    assert model_names(fppd) == ["Wall"], model_names(fppd)
    before = fppd.log().count(MARKER)
    save_outputs(fppd, colorlight_panel(LEDPanelMatrixName="Wall", description="Front"))
    fppd.wait_for(lambda: fppd.log().count(MARKER) > before, timeout=15, what="the outputs to reload")
    fppd.wait_for(lambda: "Front" in model_names(fppd), what=f"the described model (have {model_names(fppd)})")
