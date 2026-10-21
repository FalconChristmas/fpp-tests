"""The PipeWire configs fppinit writes at boot mark every object nofail.

Regression: 1f848df41. A context.objects entry is mandatory by default: if one
fails to open (an adapter for a card that went away, or an HDMI monitor that
is switched off), the PipeWire daemon exits, and systemd restarts it forever,
taking all audio and video routing with it. nofail skips just that object.

The objects are adapters for real cards, so this needs one: it runs with
run-local.sh on a device (verified on a Pi 4's headphone jack) and skips in
Docker. The PHP generators' half is web/tests/pw-input-groups-conf.spec.ts.
"""

import re

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit_audio_cards import CONF, SINKS, needs_card, prime


def objects(conf):
    """The text of each { factory = ... } entry of every context.objects list."""
    out = []
    for m in re.finditer(r"context\.objects\s*=\s*\[(.*?)\n\]", conf, re.S):
        out += [p for p in re.split(r"\n  \{ ", "\n" + m.group(1)) if "factory" in p]
    return out


@needs_card
def test_the_boot_adapters_for_a_card_are_nofail(fppinit):
    """setupAudio for a real card writes an fpp_alsa_ adapter for it in
    95-fpp-alsa-sink.conf (and the Simple-mode group in 97): every object
    in them carries nofail."""
    cid, n, out = prime(fppinit)
    checked = 0
    for path in (SINKS, CONF + "97-fpp-audio-groups.conf"):
        conf = fppinit.written(path) or ""
        objs = objects(conf)
        missing = [o for o in objs if "flags = [ nofail ]" not in o]
        assert not missing, f"{path}: objects without nofail:\n{missing}\n--- whole config:\n{conf}"
        checked += len(objs)
    assert checked, f"no context.objects were written, so this proves nothing:\n{out[-3000:]}"
