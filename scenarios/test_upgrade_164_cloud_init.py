"""Upgrade 164 turns cloud-init off on a Raspberry Pi, which FPP never uses.

Raspberry Pi OS runs cloud-init on every boot (its seed files are on the
boot partition), inside sysinit.target: ~70 s on a Pi Zero, which held up
everything after it, the Wi-Fi supplicant's start job included (#3178).
Upgrade 164 creates /etc/cloud/cloud-init.disabled, which cloud-init
checks at boot.
"""

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

DISABLED = "/etc/cloud/cloud-init.disabled"


def dpkg_query(installed):
    """dpkg-query, answering for cloud-init as dpkg does once it is
    installed, or removed with its config files left."""
    status = "install ok installed" if installed else "deinstall ok config-files"
    return f"#!/bin/sh\nprintf '%s' '{status}'\n"


def upgrade(fppinit, platform, installed=True, desktop=False):
    fppinit.write("settings", "")
    fppinit.root_file("/etc/fpp/platform", platform + "\n")
    fppinit.root_file("/usr/bin/dpkg-query", dpkg_query(installed))
    fppinit.root_file("/etc/fpp/desktop", "" if desktop else None)
    fppinit.root_file(DISABLED, None)
    r = fppinit._run(["sh", "-c", f"/opt/fpp/upgrade/164/upgrade.sh; echo \"exited $?\"; "
                                  f"test -e {DISABLED} && echo DISABLED || echo ENABLED"],
                     timeout=60, media_home=True)
    out = r.stdout + r.stderr
    assert "exited 0" in out, out[-3000:]
    return out


def test_upgrade_164_turns_cloud_init_off_on_a_pi(fppinit):
    """Regression: fd2dc83d2 (the step itself). Nothing turned cloud-init
    off on an existing Pi, so every boot waited for it."""
    out = upgrade(fppinit, "Raspberry Pi")
    assert out.rstrip().endswith("DISABLED"), out[-3000:]


@pytest.mark.parametrize("platform, installed, desktop", [
    ("BeagleBone 64", True, False),
    ("Raspberry Pi", True, True),
    ("Raspberry Pi", False, False),
], ids=["not a Pi", "a desktop install", "cloud-init removed, config files left"])
def test_upgrade_164_leaves_cloud_init_alone_where_fpp_does_not_own_it(fppinit, platform, installed, desktop):
    """Not on another board, not on a desktop install (FPP doesn't manage
    that system), and not where cloud-init isn't installed."""
    out = upgrade(fppinit, platform, installed, desktop)
    assert out.rstrip().endswith("ENABLED"), out[-3000:]


def test_upgrade_164_can_run_again(fppinit):
    """Run twice (an update re-run), the second run finds it already off."""
    upgrade(fppinit, "Raspberry Pi")
    fppinit.root_file(DISABLED, "")
    r = fppinit._run(["/opt/fpp/upgrade/164/upgrade.sh"], timeout=60, media_home=True)
    out = r.stdout + r.stderr
    assert r.returncode == 0 and "Already disabled" in out, out[-3000:]
