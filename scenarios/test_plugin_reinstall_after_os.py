"""The prompt to reinstall plugins after an FPPOS upgrade: fppinit's first
boot after the reflash flags it when plugins survived (in the fppinit
sandbox, fppinit.py), and fppd turns the flag into a warning with a Fix
link to the Plugin Manager's Reinstall All, which goes away when the flag
is cleared under it."""

import os

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit import assert_clean, media_settings, reflash_boot, seed_plugin

WARNING_ID = 57


def test_a_reflash_with_plugins_asks_for_their_reinstall(fppinit):
    """The first boot after an FPPOS reflash sets pluginReinstallNeededAfterOS
    when a plugin (a directory with a pluginInfo.json) survived in the media
    directory.

    Feature: 4fab04355. Nothing told the user that plugins built or
    installed for the old OS had to be reinstalled."""
    seed_plugin(fppinit, "fpp-kept", "https://github.com/FalconChristmas/fpp-kept.git")
    assert_clean(reflash_boot(fppinit))
    assert media_settings(fppinit).get("pluginReinstallNeededAfterOS"), media_settings(fppinit)


def test_a_reflash_without_plugins_asks_for_nothing(fppinit):
    """With no plugin in the media directory (a directory without a
    pluginInfo.json is not one), the reflash's first boot leaves
    pluginReinstallNeededAfterOS unset. (The control for the test above.)"""
    fppinit.write("plugins/not-a-plugin/README", "")
    assert_clean(reflash_boot(fppinit))
    assert not media_settings(fppinit).get("pluginReinstallNeededAfterOS"), media_settings(fppinit)


def reinstall_warnings(fppd):
    return [w for w in fppd.get("/fppd/status").get("warningInfo", []) if w.get("id") == WARNING_ID]


def test_fppd_warns_until_the_plugins_are_reinstalled(fppd):
    """With pluginReinstallNeededAfterOS set, fppd raises the "plugins must
    be reinstalled" warning, carrying a Fix link (fixUrl, fixText) to the
    Plugin Manager's Reinstall All; when the Plugin Manager clears the
    setting (a settings-file write, as SetSetting makes), the warning goes
    without a restart.

    Feature: 4fab04355."""
    fppd.settings(pluginReinstallNeededAfterOS="1")
    fppd.start()
    fppd.wait_for(lambda: reinstall_warnings(fppd), timeout=10, what="the reinstall warning")
    w = reinstall_warnings(fppd)[0]
    assert "reinstalled" in w.get("message", ""), w
    assert w.get("data", {}).get("fixUrl") == "plugins.php?action=reinstallAll", w
    assert w.get("data", {}).get("fixText"), w
    with open(os.path.join(fppd.media, "settings"), "a") as f:
        f.write('pluginReinstallNeededAfterOS = ""\n')
    fppd.wait_for(lambda: not reinstall_warnings(fppd), timeout=10,
                  what="the reinstall warning to go once the setting was cleared")
