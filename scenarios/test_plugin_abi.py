"""The native plugin ABI, as fppd's loader sees it: plugins built against
another FPP's headers -- a copy of the tree's headers with a layout changed,
or none of the symbols a current build exports -- are refused at load with a
line in the log saying why, and fppd carries on; a plugin built against the
tree's own headers next to them loads. The plugins are abiplugin.cpp and a
C one written here, built by plugin_build.py."""

import os
import subprocess

import pytest

import plugin_build
from test_plugin_scripts import probe


def commands(fppd):
    return {c["name"] for c in fppd.get("/commands")}


def wait_loaded(fppd, name):
    fppd.wait_for(lambda: f"{name} Ping" in commands(fppd), timeout=15, interval=0.25,
                  what=f"plugin {name} to load and register its command")
    assert str(fppd.command(f"{name} Ping", "x")) == "pong"


# The two ways the FPPLogger layout has moved under built plugins: the
# instance growing (the crashRingCapture member, which plugins built before
# it lack) and a facility inserted ahead of later ones.
LOGGER_EDITS = {
    "instance-size": {"log.h": [
        ("        this->crashRingCapture = crashRingCapture;\n", ""),
        ("    bool crashRingCapture = true;\n", ""),
    ]},
    "facility-inserted": {"log.h": [
        ('    FPPLoggerInstance Plugin = FPPLoggerInstance("Plugin");\n',
         '    FPPLoggerInstance Extra = FPPLoggerInstance("Extra");\n'
         '    FPPLoggerInstance Plugin = FPPLoggerInstance("Plugin");\n'),
    ]},
}


@pytest.mark.parametrize("edit", sorted(LOGGER_EDITS))
def test_a_plugin_built_with_another_logger_layout_is_refused(fppd, edit):
    """A plugin built against log.h with a different FPPLoggerInstance
    layout -- a member fewer, or a facility more -- is refused at load with
    a log line naming the FPPLogger layout, while one built against the
    tree's own log.h loads and logs.

    Regression: 251e35d19. The VB_* macros a plugin compiles in are offsets
    into FPPLogger::INSTANCE, and nothing compared the plugin's idea of that
    layout with libfpp's: such a plugin was loaded and handed _LogWrite() a
    reference into the middle of another facility on its first log line."""
    headers = plugin_build.header_copy(LOGGER_EDITS[edit])
    plugin_build.build_and_install(fppd, "abiplugin.cpp", "fpp-abi-old", include_first=[headers])
    plugin_build.build_and_install(fppd, "abiplugin.cpp", "fpp-abi-current")
    fppd.start()
    wait_loaded(fppd, "fpp-abi-current")
    assert "abi plugin fpp-abi-current loaded" in fppd.log()
    fppd.wait_for(lambda: "libfpp-abi-old.so was built with a" in fppd.log(), timeout=10,
                  what="the loader to refuse the plugin built against the other log.h")
    refusal = [l for l in fppd.log().splitlines() if "libfpp-abi-old.so was built with a" in l]
    assert any("FPPLogger" in l for l in refusal), refusal
    assert "fpp-abi-old Ping" not in commands(fppd)
    assert "abi plugin fpp-abi-old loaded" not in fppd.log()
    fppd.check_alive()


def test_a_plugin_built_with_another_command_arg_layout_is_refused(fppd):
    """A plugin built against a Commands.h whose CommandArg has a member
    more -- what each API version 4 and 5 break was, a field added without a
    version bump -- is refused at load with a log line giving both sizes,
    and one built against the tree's own header loads; both construct a
    CommandArg and push it onto Command::args.

    Regression: d8ebff380. The API version was the only gate, and it agreed:
    the plugin was loaded, built its std::list nodes with its own
    sizeof(CommandArg), and libfpp walked and destroyed them with another."""
    headers = plugin_build.header_copy({"commands/Commands.h": [
        ("        bool adjustable;\n", "        bool adjustable;\n        std::string addedLater;\n"),
    ]})
    plugin_build.build_and_install(fppd, "abiplugin.cpp", "fpp-abi-old", include_first=[headers])
    plugin_build.build_and_install(fppd, "abiplugin.cpp", "fpp-abi-current")
    fppd.start()
    wait_loaded(fppd, "fpp-abi-current")
    fppd.wait_for(lambda: "libfpp-abi-old.so was built with a" in fppd.log(), timeout=10,
                  what="the loader to refuse the plugin built against the other Commands.h")
    refusal = [l for l in fppd.log().splitlines() if "libfpp-abi-old.so was built with a" in l]
    assert any("Command::CommandArg" in l for l in refusal), refusal
    assert "fpp-abi-old Ping" not in commands(fppd)
    fppd.check_alive()


NO_VERSION = r"""
#include <stdio.h>
#include <stdlib.h>
/* No fpp_plugin_api_version(): built before there was one. */
void* createPlugin(void) {
    const char* p = getenv("FPP_TEST_PROBE");
    FILE* f = p ? fopen(p, "a") : NULL;
    if (f) { fputs("created\n", f); fclose(f); }
    return NULL;
}
"""


def test_a_plugin_that_never_defined_an_api_version_is_refused(fppd):
    """A plugin library that defines no fpp_plugin_api_version() of its own
    (built before the symbol existed) but links libfpp, as every plugin
    does, is refused before its createPlugin() runs, with the "compiled
    against an older FPP API" line.

    Regression: 9536b606f. dlsym() on the plugin's handle also searches its
    dependencies, and libfpp exports the weak symbol itself, so the lookup
    found libfpp's own copy, the versions trivially matched and the stale
    plugin's createPlugin() was called."""
    d = plugin_build.install(fppd, "fpp-noversion")
    src = os.path.join(d, "noversion.c")
    with open(src, "w") as f:
        f.write(NO_VERSION)
    so = os.path.join(d, "libfpp-noversion.so")
    lib = plugin_build.tree_src()
    # --no-as-needed: nothing here calls into libfpp, but a real plugin does,
    # so it has libfpp as a dependency.
    subprocess.run(["cc", "-shared", "-fPIC", "-o", so, src, "-Wl,--no-as-needed", f"-L{lib}", "-lfpp"],
                   check=True)
    needed = subprocess.run(["readelf", "-d", so], capture_output=True, text=True).stdout
    assert "libfpp.so" in needed, "the test library must depend on libfpp, as plugins do"
    log = os.path.join(fppd.media, "tmp", "probe.log")
    fppd.start(extra_env={"FPP_TEST_PROBE": log})
    fppd.wait_for(lambda: "libfpp-noversion.so" in fppd.log() and
                  ("older FPP API" in fppd.log() or "Failed to create plugin" in fppd.log()),
                  timeout=15, what="fppd to deal with the plugin")
    assert probe(log) == [], "the version-less plugin's createPlugin() was called"
    assert "libfpp-noversion.so was compiled against an older FPP API" in fppd.log()
    fppd.check_alive()


def test_a_plugin_that_includes_drogon_still_logs(fppd):
    """A plugin that includes a drogon header after log.h and before
    Plugin.h -- as plugins using drogon directly do -- builds, and the
    LogWarn() in its constructor reaches fppd's log.

    Regression: 2acb4047c. drogon's trantor #defines LOG_WARN, LOG_INFO and
    LOG_DEBUG, the names log.h's LogWarn()/LogInfo()/LogDebug() expand to.
    fpphttp.h #undefs them, but Plugin.h and Commands.h had moved to
    fpphttp_types.h, which did not, so such a plugin no longer compiled
    (here: plugin_build.build() raises with the compiler's error)."""
    plugin_build.build_and_install(fppd, "abiplugin.cpp", "fpp-abi-drogon", defines=["ABI_DROGON_FIRST"])
    fppd.start()
    wait_loaded(fppd, "fpp-abi-drogon")
    assert "abi plugin fpp-abi-drogon loaded" in fppd.log()


def test_a_plugin_built_against_the_three_argument_periodic_timer_loads(fppd):
    """A plugin built when Timers::addPeriodicTimer took three arguments
    (before d7b5ecb51 added initialDelayMS) loads, and the periodic timer it
    starts through that call fires.

    Regression: 3d8aab31c. d7b5ecb51 gave the fourth argument a default,
    which changed the function's mangled name, so libfpp no longer exported
    the 3-argument symbol such a plugin links: fppd's dlopen() refused the
    plugin with an undefined symbol."""
    plugin_build.build_and_install(fppd, "abiplugin.cpp", "fpp-abi-timer", defines=["ABI_PREBUILT_TIMERS"])
    fppd.start()
    wait_loaded(fppd, "fpp-abi-timer")
    fppd.wait_for(lambda: fppd.log().count("abi plugin fpp-abi-timer timer fired") >= 3, timeout=10,
                  what="the plugin's periodic timer to fire")
    fppd.check_alive()


def test_a_plugin_built_before_disallow_multisync_is_listed_and_runs(fppd):
    """A plugin whose Command subclass was built against Commands.h as it
    was before d7b5ecb51 -- no disallowMultisync() virtual -- is listed by
    GET /commands and its command runs, and If still carries the
    disallowMultisync flag the UI reads.

    Regression: abfe12046. d7b5ecb51 inserted the virtual ahead of run(),
    and Command::getDescription() called it, so describing the plugin's
    command dispatched into the slot the plugin has run() in: the first
    GET /commands crashed fppd (here: the plugin's run() writes its result
    over the object's vtable pointer). Where the tree's own Commands.h no
    longer has the virtual, the plugin is built against it unchanged."""
    with open(os.path.join(plugin_build.tree_src(), "commands", "Commands.h")) as f:
        has_virtual = "    virtual bool disallowMultisync() const { return false; }\n" in f.read()
    edits = {"commands/Commands.h": [("    virtual bool disallowMultisync() const { return false; }\n", "")]} \
        if has_virtual else {}
    headers = plugin_build.header_copy(edits)
    plugin_build.build_and_install(fppd, "abiplugin.cpp", "fpp-abi-prems", include_first=[headers])
    fppd.start()
    fppd.wait_for(lambda: "abi plugin fpp-abi-prems loaded" in fppd.log(), timeout=15,
                  what="the plugin to load")
    listed = {c["name"]: c for c in fppd.get("/commands")}
    assert "fpp-abi-prems Ping" in listed, sorted(listed)
    assert not listed["fpp-abi-prems Ping"].get("disallowMultisync"), listed["fpp-abi-prems Ping"]
    assert listed["If"].get("disallowMultisync") is True, listed["If"]
    assert str(fppd.command("fpp-abi-prems Ping", "x")) == "pong"
    fppd.check_alive()


def test_a_command_that_cannot_describe_itself_leaves_the_rest_listed(fppd):
    """A plugin command whose getDescription() throws -- what a stale
    plugin's does when it reads a std::string at another layout's offset --
    is left out of GET /commands, which still answers 200 with every other
    command, the plugin's working one included; fppd stays up.

    Regression: 9e1620a69. getDescriptions() had no guard around each
    command, so the one exception took out the whole list (a 500) and with
    it every page that edits a command."""
    plugin_build.build_and_install(fppd, "abiplugin.cpp", "fpp-abi-broken", defines=["ABI_THROWING_DESCRIPTION"])
    fppd.start()
    fppd.wait_for(lambda: "abi plugin fpp-abi-broken loaded" in fppd.log(), timeout=15,
                  what="the plugin to load")
    names = commands(fppd)
    assert "fpp-abi-broken Ping" in names and "Start Playlist" in names, sorted(names)
    assert "fpp-abi-broken Broken" not in names
    assert str(fppd.command("fpp-abi-broken Ping", "x")) == "pong"
    fppd.check_alive()
