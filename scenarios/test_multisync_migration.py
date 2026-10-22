"""How an existing MultiSync master keeps the send method it had when FPP 10
changed the default to unicast-to-all-known-remotes: config upgrades 122 and
132 for an in-place upgrade, and fppinit's own migration on the first boot
after an FPPOS reflash (which runs no upgrade scripts), in the fppinit
sandbox (fppinit.py).
"""

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_fppinit_migrations import assert_clean, media_settings

METHODS = ("MultiSyncMulticast", "MultiSyncBroadcast", "MultiSyncUnicast")


def methods(sb):
    s = media_settings(sb)
    return {k: s[k] for k in METHODS if k in s}


def after_reflash(sb):
    """The first postNetwork after an FPPOS reflash."""
    sb.root_file("/fppos_upgraded", "")
    r = sb._run(["/opt/fpp/src/fppinit", "postNetwork"], timeout=300, media_home=True)
    assert_clean(r)


def upgrade(sb, n):
    """Config upgrade n, on the sandbox's settings file (scripts/common
    otherwise finds the media directory from the tree's media_root.txt)."""
    r = sb._run(["env", f"CFGFILE={MEDIA}/settings", f"/opt/fpp/upgrade/{n}/upgrade.sh"])
    assert r.returncode == 0, f"{n} exited {r.returncode}:\n{(r.stdout + r.stderr)[-3000:]}"


def test_a_reflash_keeps_a_master_with_no_send_method_on_multicast(fppinit):
    """A MultiSync master that never recorded a send method (multicast was
    the implicit default) is pinned to multicast on the first boot after an
    FPPOS reflash, unicast off; a method the user chose is left alone.

    Regression: 8f4ab3338. Before it only upgradeOS-part1.sh did this, from
    the old image's copy, and fppinit nothing: the reflashed box read the
    new default and switched to unicast.
    """
    fppinit.settings(MultiSyncEnabled="1")
    after_reflash(fppinit)
    assert methods(fppinit) == {"MultiSyncMulticast": "1", "MultiSyncUnicast": "0"}, \
        fppinit.media_file("settings")

    fppinit.write("settings", 'MultiSyncEnabled = "1"\nMultiSyncUnicast = "1"\n')
    after_reflash(fppinit)
    assert methods(fppinit) == {"MultiSyncUnicast": "1"}, fppinit.media_file("settings")


def test_a_reflash_pins_an_unrecorded_unicast_setting_off(fppinit):
    """A master that chose multicast but has no MultiSyncUnicast key gets
    one, 0, on the first boot after a reflash: absent, the UI and fppd read
    the new default (1) and unicast every sync packet to every known remote
    on top of the multicast. An explicit 1 is the user's and stays.

    Regression: 90e09a36f. The migration wrote MultiSyncUnicast only when no
    method at all was set, so a master that had picked multicast kept the
    key absent.
    """
    fppinit.settings(MultiSyncEnabled="1", MultiSyncMulticast="1")
    after_reflash(fppinit)
    assert methods(fppinit) == {"MultiSyncMulticast": "1", "MultiSyncUnicast": "0"}, \
        fppinit.media_file("settings")

    fppinit.write("settings", 'MultiSyncEnabled = "1"\nMultiSyncBroadcast = "1"\nMultiSyncUnicast = "1"\n')
    after_reflash(fppinit)
    assert methods(fppinit) == {"MultiSyncBroadcast": "1", "MultiSyncUnicast": "1"}, \
        fppinit.media_file("settings")


def test_upgrade_132_pins_an_unrecorded_unicast_setting_off(fppinit):
    """Upgrade 132 does the same for an in-place upgrade: a master on
    multicast with no MultiSyncUnicast key gets 0; an explicit 1 stays, and
    a box with MultiSync off is not touched.

    Regression: 90e09a36f, which added it (weak: red on the parent because
    the script isn't there; it guards what it writes).
    """
    fppinit.settings(MultiSyncEnabled="1", MultiSyncMulticast="1")
    upgrade(fppinit, 132)
    assert methods(fppinit) == {"MultiSyncMulticast": "1", "MultiSyncUnicast": "0"}, \
        fppinit.media_file("settings")

    fppinit.write("settings", 'MultiSyncEnabled = "1"\nMultiSyncMulticast = "1"\nMultiSyncUnicast = "1"\n')
    upgrade(fppinit, 132)
    assert methods(fppinit) == {"MultiSyncMulticast": "1", "MultiSyncUnicast": "1"}, \
        fppinit.media_file("settings")

    fppinit.write("settings", 'MultiSyncMulticast = "1"\n')
    upgrade(fppinit, 132)
    assert methods(fppinit) == {"MultiSyncMulticast": "1"}, fppinit.media_file("settings")


def test_upgrade_122_keeps_a_master_with_no_send_method_on_multicast(fppinit):
    """Upgrade 122: a MultiSync master with no send method recorded is
    pinned to multicast, unicast off, when it upgrades to FPP 10; one that
    chose broadcast, or has MultiSync off, is left as it is.

    Regression: e177436bc, which changed the default for new users to
    unicast and added this so existing ones keep multicast (weak: red on the
    parent because the script isn't there).
    """
    fppinit.settings(MultiSyncEnabled="1")
    upgrade(fppinit, 122)
    assert methods(fppinit) == {"MultiSyncMulticast": "1", "MultiSyncUnicast": "0"}, \
        fppinit.media_file("settings")

    fppinit.write("settings", 'MultiSyncEnabled = "1"\nMultiSyncBroadcast = "1"\n')
    upgrade(fppinit, 122)
    assert methods(fppinit) == {"MultiSyncBroadcast": "1"}, fppinit.media_file("settings")

    fppinit.write("settings", 'fppMode = "player"\n')
    upgrade(fppinit, 122)
    assert methods(fppinit) == {}, fppinit.media_file("settings")
