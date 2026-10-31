"""Native plugins unloaded at runtime and at shutdown: what an unload has to
take back (the library mapping, the plugin's commands), finding the plugin
by the directory it was installed from, and an unload run from inside a
FileMonitor callback. The plugin is lifecycleplugin.cpp, built by
plugin_build.py -- through the tree's own plugin makefile fragment where the
build flags are what is tested. The receiving end is fppd itself: its
/proc/<pid>/maps, its command registry and its exit status."""

import os
import tempfile
import urllib.error

import plugin_build


def commands(fppd):
    return {c["name"] for c in fppd.get("/commands")}


def unload(fppd, dirname):
    return fppd.post(f"/fppd/plugin/{dirname}/unload", {}, timeout=40)


def run_refused(fppd, name):
    """Running the command `name` is refused with fppd's "No Command"
    error rather than run."""
    try:
        r = fppd.command(name)
    except urllib.error.HTTPError as e:
        r = e.body
    return "No Command: " + name in str(r)


def test_a_plugin_with_a_static_local_is_unmapped_on_unload(fppd):
    """A plugin built with the tree's own plugin makefile fragment, with a
    static local in a method defined in its class body, has its library
    gone from fppd's address space once it is unloaded.

    Regression: 24abe9828. GCC emits such a static as an STB_GNU_UNIQUE
    symbol, and glibc marks the first object to define one NODELETE:
    dlclose() returned success and unmapped nothing, so a plugin declaring
    FPP_PLUGIN_SUPPORTS_UNLOAD stayed mapped for the life of fppd. setup.mk
    now builds plugins -fno-gnu-unique."""
    # The control: built without the flag, this source does define one.
    plain = plugin_build.build("lifecycleplugin.cpp", os.path.join(tempfile.mkdtemp(), "libplain.so"),
                               defines=['PLUGIN_NAME="plain"', "LC_STATIC_LOCAL"], sanitize=False)
    assert plugin_build.unique_symbols(plain), "the test plugin has no STB_GNU_UNIQUE symbol to prove anything"

    plugin_build.make_build(fppd, "lifecycleplugin.cpp", "fpp-statics", defines=["LC_STATIC_LOCAL"])
    fppd.start()
    fppd.wait_for(lambda: "fpp-statics Ping" in commands(fppd), timeout=15, interval=0.25,
                  what="the plugin to load")
    assert str(fppd.command("fpp-statics Ping")) == "static-local fpp-statics"
    assert plugin_build.mapped(fppd, "fpp-statics"), "the plugin's library is not mapped while loaded"
    unload(fppd, "fpp-statics")
    fppd.wait_for(lambda: "Unloaded plugin fpp-statics (library unmapped)" in fppd.log(), timeout=10,
                  what="the unload to close the library")
    left = plugin_build.mapped(fppd, "fpp-statics")
    assert not left, "dlclose() left the plugin mapped:\n" + "\n".join(left)


def test_unloading_a_plugin_whose_name_differs_from_its_directory(fppd):
    """A plugin whose own name differs from the directory it was installed
    from is unloaded by POST /fppd/plugin/<directory>/unload: its command is
    withdrawn and its library unmapped.

    Regression: 2de16360e. unloadPlugin() looked the plugin up by its own
    name, found nothing under the directory name every caller passes, and
    reported success with nothing unloaded -- after which an uninstall
    deleted the files of a plugin still running."""
    plugin_build.build_and_install(fppd, "lifecycleplugin.cpp", "fpp-dirname", plugin_name="DirTest",
                                   extra=["-fno-gnu-unique"])
    fppd.start()
    fppd.wait_for(lambda: "DirTest Ping" in commands(fppd), timeout=15, interval=0.25,
                  what="the plugin to load")
    assert str(fppd.command("DirTest Ping")) == "DirTest"
    assert plugin_build.mapped(fppd, "fpp-dirname")
    unload(fppd, "fpp-dirname")
    assert "DirTest Ping" not in commands(fppd), "the unload did not reach the plugin"
    fppd.wait_for(lambda: not plugin_build.mapped(fppd, "fpp-dirname"), timeout=10,
                  what="the plugin's library to be unmapped")


def test_a_plugins_commands_are_withdrawn_when_it_unloads(fppd):
    """A plugin that registers a command and never withdraws it has the
    command taken back when it is unloaded: it is gone from /commands,
    running it by name is refused, and fppd logs that the plugin left it.

    Regression: 48d30e226. Nothing tracked the commands a C++ plugin added,
    so after an unload the command stayed listed and runnable, dispatching
    into a destroyed plugin in a library that was no longer mapped (here
    the listing alone crashed fppd).

    Also guards 7b882c6b8, CommandManager::removeCommand(name), which the
    unload uses to withdraw them: with it doing nothing, the listing after
    the unload crashes fppd the same way."""
    plugin_build.build_and_install(fppd, "lifecycleplugin.cpp", "fpp-leaky", defines=["LC_LEAK_COMMANDS"],
                                   extra=["-fno-gnu-unique"])
    fppd.start()
    fppd.wait_for(lambda: "fpp-leaky Ping" in commands(fppd), timeout=15, interval=0.25,
                  what="the plugin to load")
    unload(fppd, "fpp-leaky")
    fppd.wait_for(lambda: "Unloaded plugin fpp-leaky" in fppd.log(), timeout=10, what="the unload")
    assert "fpp-leaky Ping" not in commands(fppd)
    assert run_refused(fppd, "fpp-leaky Ping")
    assert "Plugin fpp-leaky left 1 command(s) registered at unload (fpp-leaky Ping)" in fppd.log()
    fppd.check_alive()


def test_a_plugin_that_leaves_a_command_registered_at_shutdown(fppd):
    """A plugin loaded at startup that registers a command and never
    removes it: fppd still stops cleanly on SIGTERM (the fixture's check),
    the command being deleted while the plugin's library is still mapped.

    Regression: 0e16c3f1d. PluginManager::Cleanup() dlclose()d the plugin
    libraries before CommandManager deleted the commands left registered,
    so deleting this one ran its destructor through a vtable in an unmapped
    library: fppd died of SIGSEGV on the way out."""
    plugin_build.build_and_install(fppd, "lifecycleplugin.cpp", "fpp-leaky", defines=["LC_LEAK_COMMANDS"],
                                   extra=["-fno-gnu-unique"])
    fppd.start()
    fppd.wait_for(lambda: "fpp-leaky Ping" in commands(fppd), timeout=15, interval=0.25,
                  what="the plugin to load")
    assert str(fppd.command("fpp-leaky Ping")) == "fpp-leaky"
    assert plugin_build.mapped(fppd, "fpp-leaky")


def test_a_file_monitor_callback_that_unloads_a_plugin(fppd):
    """A FileMonitor callback (a plugin watching a file) that unloads
    another plugin -- which takes that plugin's settings watch out of the
    FileMonitor -- returns, and the unload completes.

    Regression: d0684bee4. FileMonitor ran its callbacks with its lock held,
    and removing a watch takes the same lock: the main loop deadlocked on
    itself inside the callback, and fppd stopped running its main loop."""
    trigger = os.path.join(fppd.media, "tmp", "lc-trigger")
    plugin_build.build_and_install(fppd, "lifecycleplugin.cpp", "fpp-victim", extra=["-fno-gnu-unique"])
    plugin_build.build_and_install(fppd, "lifecycleplugin.cpp", "fpp-watcher", defines=["LC_FILEMON"],
                                   extra=["-fno-gnu-unique"])
    fppd.start(extra_env={"LC_WATCH": trigger, "LC_VICTIM": "fpp-victim"})
    fppd.wait_for(lambda: {"fpp-victim Ping", "fpp-watcher Unloaded"} <= commands(fppd), timeout=15,
                  interval=0.25, what="both plugins to load")
    assert str(fppd.command("fpp-watcher Unloaded")) == "no"
    with open(trigger, "w") as f:
        f.write("go\n")
    fppd.wait_for(lambda: str(fppd.command("fpp-watcher Unloaded")) != "no", timeout=15, interval=0.25,
                  what="the FileMonitor callback's unload to return")
    assert str(fppd.command("fpp-watcher Unloaded")) == "ok"
    assert "fpp-victim Ping" not in commands(fppd)
    fppd.wait_for(lambda: not plugin_build.mapped(fppd, "fpp-victim"), timeout=10,
                  what="the unloaded plugin's library to be unmapped")
