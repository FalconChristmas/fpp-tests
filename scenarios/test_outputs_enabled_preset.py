"""The OUTPUTS_ENABLED command preset, fired when outputs are turned on."""

from show import CHANNELS, ddp_output

FX = 30  # the model: channels 1-30


def active(fppd):
    return any(m.get("isActive") for m in fppd.get("/overlays/models", timeout=5))


def test_turning_outputs_on_fires_the_outputs_enabled_preset(fppd):
    """An OUTPUTS_ENABLED command preset that enables an overlay model:
    with the model switched off again, the Outputs On command turns it
    back on.

    Feature: 44272e267 (the OUTPUTS_ENABLED and OUTPUTS_DISABLED presets,
    fired by the output monitor as outputs go on and off).
    """
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": "Lit", "Type": "Channel", "StartChannel": 1, "ChannelCount": FX,
        "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": 1, "StrandsPerString": 1}]})
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "OUTPUTS_ENABLED", "command": "Overlay Model State",
        "args": ["Lit", "Enabled"], "presetSlot": 0}]})
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("Overlay Model State", "Lit", "Disabled")
    fppd.wait_for(lambda: not active(fppd), timeout=10, what="the model to be switched off")
    fppd.command("Outputs On")
    fppd.wait_for(lambda: active(fppd), timeout=10, what="the preset to enable the model")
