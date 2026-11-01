"""A plugin can add a pixel overlay effect."""

from ddp import DdpReceiver
from test_overlays import CHANNELS, matrix, setup, wait_output


def test_a_plugin_can_add_a_pixel_overlay_effect(fppd):
    """An effect a plugin registers with PixelOverlayEffect::AddPixelOverlayEffect()
    is in the effect list, and the Overlay Model Effect command runs it on a
    model.

    Feature: 9b729e3b5. Plugins had no way to add an effect."""
    from native_plugin import install
    install(fppd, features=["NATIVE_OVERLAY_EFFECT"])
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        names = [e if isinstance(e, str) else e.get("name") for e in fppd.get("/overlays/effects")]
        assert "Native Test Effect" in names, f"the plugin's effect is not listed: {names}"
        fppd.command("Overlay Model Effect", "M", "Enabled", "Native Test Effect")
        wait_output(fppd, rx, lambda f: f[:6] == bytes([11, 22, 33] * 2),
                    "the plugin's effect to fill the model", timeout=5)
