"""The display listing (fpp -FB) skips a /dev/dri card that has no display
resources instead of dying on it."""

import fakedrm
from test_display_listing import fake_fb, listing


def test_a_card_without_display_resources_does_not_end_the_listing(fppd):
    """A card under /dev/dri whose drmModeGetResources() fails (a render-only
    GPU node, or one a driver has not finished binding) is passed over; the
    listing still comes back, with the fbdev device a box without a usable
    KMS display offers.

    Regression: 3ec0463fd. The resources were dereferenced unchecked, so
    `fpp -FB` crashed on such a card and every display picker that reads it
    came back empty."""
    fake_fb(fppd)
    fppd.start()
    preload, env = fakedrm.panel_env(fppd, "DSI-1", "800x480")
    env["FAKEDRM_NO_RESOURCES"] = "1"
    assert listing(fppd, preload, env) == ["fb0"]
    # The control that the card was really reached: with resources, its
    # connector is listed (and the fb device is not).
    env["FAKEDRM_NO_RESOURCES"] = "0"
    assert listing(fppd, preload, env) == ["DSI-1"]
