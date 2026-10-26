"""The display devices the `fpp` CLI lists (fpp -FB, which the UI's display
pickers read through /api/options): the KMS connectors of the cards under
/dev/dri, and the fbdev devices only on a box that has no KMS."""

import json
import os
import subprocess

import fakedrm
from fppd import sanitizer_runtime


def listing(fppd, preload=(), env=None, *args):
    fpp = os.path.join(fppd.tree, "src", "fpp")
    e = dict(os.environ, LD_LIBRARY_PATH=os.path.join(fppd.tree, "src"))
    if preload:
        e["LD_PRELOAD"] = " ".join(sanitizer_runtime(fpp) + list(preload))
    e.update(env or {})
    r = subprocess.run([fpp, *(args or ("-FB",))], capture_output=True, text=True, timeout=30, env=e)
    assert r.returncode == 0, f"fpp {args} exited {r.returncode}: {r.stderr[-2000:]}"
    # The listing is the last line: in a container the CLI first logs that it
    # can't work out the box's UUID.
    try:
        return json.loads(r.stdout.rsplit("\n", 1)[-1])
    except ValueError:
        raise AssertionError(f"fpp {args} printed {r.stdout[-2000:]!r}")


def fake_fb(fppd):
    """An fb0 where fppd and the CLI look for framebuffers."""
    d = os.path.join(fppd.media, "fakefb")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "fb0"), "wb") as f:
        f.truncate(64 * 32 * 4)
    fppd.settings(framebufferControlSocketPath=d)


def test_with_a_kms_card_only_its_connectors_are_listed(fppd):
    """A box with a KMS card (fakedrm.so: one with a DSI panel on DSI-1) and
    an fbdev device lists the card's connector and not the fb device, in
    both the plain and the debug listing.

    Regression: 7f77fe16e. The fb devices were listed first and the KMS
    connectors after them, so a KMS box offered its fbdev emulation
    device as a display next to the real connector."""
    fake_fb(fppd)
    fppd.start()
    preload, env = fakedrm.panel_env(fppd, "DSI-1", "800x480")
    plain = listing(fppd, preload, env)
    assert plain == ["DSI-1"], f"fpp -FB listed {plain}"
    debug = listing(fppd, preload, env, "-FBdebug")
    assert sorted(debug) == ["DSI-1"], f"fpp -FBdebug listed {sorted(debug)}"
    assert "800x480@60" in debug["DSI-1"].get("modes", []), debug


def test_without_kms_the_fb_devices_are_listed(fppd):
    """With no KMS card at all, the fbdev devices are what the listing
    names: the other half of 7f77fe16e, which must not have dropped them."""
    fake_fb(fppd)
    fppd.start()
    assert listing(fppd) == ["fb0"]
