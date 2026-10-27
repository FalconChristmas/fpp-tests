"""fppd watching that the sound card AudioOutput names is still there.

fakesys.c serves fppd's /proc/asound from the media directory, so a card
can be unplugged and plugged back in by rewriting a file.
"""

import os

import shims

USB_CARD = " 1 [S3             ]: USB-Audio - Sound Blaster Play! 3\n                      Creative Technology Ltd\n"
JACK = " 0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n                      bcm2835 Headphones\n"


def plug(fppd, *cards):
    path = os.path.join(fppd.media, "fakesys", "asound", "cards")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("".join(cards) or "--- no soundcards ---\n")


def test_the_missing_card_warning_comes_and_goes_with_the_card(fppd):
    """AudioOutput names a USB card (S3) that is unplugged: within about
    half a minute (two misses ride out a re-enumeration) /fppd/status warns
    that it is not present. Plugged back in, the warning comes down by
    itself, with the setting untouched.

    Feature: e967062ab (the periodic presence check and its warning). The
    clearing half is green only from 680451806: until then the warning,
    which names the card, was removed by a text that never matched it."""
    plug(fppd, JACK)
    fppd.settings(AudioOutput="S3")
    fppd.start(preload=[shims.build("fakesys.c")],
               extra_env={"FAKESYS": "/proc/asound=" + os.path.join(fppd.media, "fakesys", "asound")})

    def warned():
        return any("Audio output card 'S3'" in w for w in fppd.get("/fppd/status").get("warnings", []))
    fppd.wait_for(warned, timeout=50, interval=1, what="the missing-card warning")
    plug(fppd, JACK, USB_CARD)
    fppd.wait_for(lambda: not warned(), timeout=25, interval=1,
                  what="the warning to come down with the card back")
