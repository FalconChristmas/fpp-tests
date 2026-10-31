"""A native plugin's settings-file watch (FPPPlugins::Plugin's
monitorSettings) across a runtime unload and load -- the way a plugin
upgrade takes effect on FPP 10, and what its config page relies on to be
heard. The plugin is settingsplugin.cpp, built by plugin_build.py; the
receiving end is the plugin's own settingChanged(), which logs each call
with the generation of the instance it reached."""

import os

import plugin_build


def commands(fppd):
    return {c["name"] for c in fppd.get("/commands")}


def seen(fppd):
    return str(fppd.command("fpp-settings Seen")).split()


def test_a_reloaded_plugin_keeps_hearing_its_settings_changes(fppd):
    """A plugin unloaded and loaded again while its old instance is still
    settling hears a change to its settings file once the old instance is
    gone, and the unloaded instance hears none.

    Regression: b4fac350d. The watch is registered under the plugin's name.
    The reload's new instance registered its watch under that name before
    the old one was deleted, and the old one's destructor then removed it
    by name: the reloaded plugin never heard a settings change again until
    fppd restarted. Until that delete the old instance, already detached,
    also kept getting settingChanged().

    Feature: 00aca118d (the settings watch itself: without it the first
    change is never heard)."""
    settings = os.path.join(fppd.media, "config", "plugin.fpp-settings")

    def write(value):
        with open(settings + ".tmp", "w") as f:
            f.write(f'flag = "{value}"\n')
        os.rename(settings + ".tmp", settings)

    plugin_build.build_and_install(fppd, "settingsplugin.cpp", "fpp-settings")
    fppd.start(extra_env={"SP_SETTLE_MS": "4000"})
    fppd.wait_for(lambda: "fpp-settings Seen" in commands(fppd), timeout=15, interval=0.25,
                  what="the plugin to load")
    # The control: the first instance hears a change.
    write("1")
    fppd.wait_for(lambda: "1:flag=1" in seen(fppd), timeout=10, interval=0.25,
                  what="the loaded plugin to hear its setting change")

    fppd.post("/fppd/plugin/fpp-settings/unload", {}, timeout=40)
    assert "Unloaded plugin fpp-settings (waiting for it to finish)" in fppd.log()
    write("2")
    fppd.post("/fppd/plugin/fpp-settings/load", {}, timeout=40)
    fppd.wait_for(lambda: "fpp-settings Seen" in commands(fppd), timeout=15, interval=0.25,
                  what="the plugin to load again")
    fppd.wait_for(lambda: "Unloaded plugin fpp-settings (library kept mapped)" in fppd.log(), timeout=15,
                  interval=0.25, what="the old instance to be deleted")
    write("3")
    fppd.wait_for(lambda: "2:flag=3" in seen(fppd), timeout=10, interval=0.25,
                  what="the reloaded plugin to hear its setting change")
    assert seen(fppd) == ["1:flag=1", "2:flag=3"]
