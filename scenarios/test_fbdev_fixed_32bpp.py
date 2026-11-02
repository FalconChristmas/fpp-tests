"""A framebuffer device that stays at 32 bits per pixel (see test_fbdev.py)."""

from framebuffer import FakeFb
from test_fbdev import H, W, fb_model, image, send, shows


def test_a_device_that_keeps_32bpp_is_drawn_four_bytes_a_pixel(fppd):
    """A driver that keeps 32 bits per pixel whatever fppd asks for (its
    fb_check_var forces the depth, and the call hands it back) gets its
    pixels four bytes apart, not the three of the 24bpp mode fppd asked for.

    Regression: a7a77a5f0 ("Support 32bpp framebuffers"). The depth was
    read before the mode was set and never again, so a device that refused
    the switch to 24bpp was written three bytes a pixel and came out
    smeared."""
    fb = FakeFb(fppd, width=W, height=H, bpp=32, pages=1, fixed="adjust")
    fb_model(fppd)
    fb.start()
    img = image(W, H)
    send(fppd, img)
    fppd.wait_for(lambda: shows(fb, img), timeout=10, what="the image on the device")
    assert fb.page()[0] == 4
