"""Native (C++) plugins: nativeplugin.cpp, built against the tree under
test, loaded by fppd as a plugin would be, and driven through the commands
it registers."""

import os
import socket
import time
import urllib.error

import pytest

from native_plugin import install


def test_a_plugin_that_throws_while_loading_is_refused(fppd):
    """A plugin whose createPlugin() throws, loaded at runtime (the Plugin
    Manager's load after an install), is refused with an error naming the
    throw, and fppd carries on.

    Regression: ab4900b1b. The load ran on the main loop with nothing
    above it to catch, so the throw was std::terminate and fppd died."""
    flag = os.path.join(fppd.media, "tmp", "throw")
    fppd.start(extra_env={"NATIVE_THROW_FLAG": flag})
    install(fppd, features=["NATIVE_THROW_CREATE"])
    open(flag, "w").close()
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.post("/fppd/plugin/fpp-native/load", {}, timeout=40)
    assert "threw" in e.value.body, e.value.body
    fppd.check_alive()
    assert fppd.get("/fppd/status")["fppd"] == "running"


def test_a_plugin_that_throws_on_multisync_data(fppd):
    """A MultiSync plugin packet for a plugin whose multiSyncData() throws
    (any host on the LAN can send one) is logged against the plugin, and
    fppd carries on.

    Regression: ab4900b1b. multiSyncData ran on the main loop with nothing
    above it to catch: one packet was std::terminate."""
    from multisync import PORT, control_packet
    install(fppd, features=["NATIVE_THROW_MULTISYNC"])
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for _ in range(3):
        sock.sendto(control_packet(5, b"fpp-native\0data"), ("127.0.0.1", PORT))
        time.sleep(0.3)
    fppd.wait_for(lambda: "threw" in fppd.log() and "multiSyncData" in fppd.log(), timeout=5,
                  what="the throw to be logged")
    fppd.check_alive()


def test_a_plugin_setting_containing_equals_signs(fppd):
    """A plugin's setting whose value contains "=" (a base64 secret) reaches
    the plugin whole.

    Regression: 07a590559. Plugin settings files were split on every "="
    (the bug already fixed in FPP's own settings loader), so the value was
    cut at its first "=": "ab==cd" came through as "ab".

    Also covers a1e9ac88c, through the shutdown every scenario ends with:
    CommandManager deleted every command before the plugins were cleaned
    up, and this plugin's destructor then removed and deleted its own
    commands again (an ASan heap-use-after-free)."""
    install(fppd, features=["NATIVE_SETTING"])
    fppd.write("config/plugin.fpp-native", 'secret = "ab==cd"\nplain = "x"\n')
    fppd.start()
    assert str(fppd.command("Native Test Setting", "plain")) == "x"
    assert str(fppd.command("Native Test Setting", "secret")) == "ab==cd"


def test_a_timer_stopped_earlier_in_the_same_pass_does_not_run(fppd):
    """Of two periodic timers due in the same pass that stop each other,
    the one stopped by the other's callback does not run.

    Regression: bb1e3e3b6. The timer pass copied every due timer before
    running any, so a timer stopped by an earlier callback in the pass still
    ran once from its copy -- when unloading a plugin from a timer, on the
    deleted plugin."""
    install(fppd, features=["NATIVE_TIMERS"])
    fppd.start()
    fppd.command("Native Test Timers", "50")
    time.sleep(1.5)
    late = int(str(fppd.command("Native Test Timer Late")))
    assert late == 0, f"{late} timers ran after they were stopped"


def test_removing_an_mqtt_callback_waits_for_its_run(fppd):
    """Events::RemoveCallback() called while the callback is running on the
    MQTT thread returns only after that run ends, so the plugin may then
    free what the callback uses (or be unloaded).

    Regression: 5e700c694. The callback map was unlocked and the callback
    ran out of it in place: removal erased the entry, destroying the
    std::function that was still executing, and returned at once."""
    from test_mqtt_control import HOST, PORT, broker, publish
    install(fppd, features=["NATIVE_EVENTS"])
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        time.sleep(2)  # connected and subscribed
        publish("set/fpptest/slow", "x")
        fppd.wait_for(lambda: str(fppd.command("Native Test In Callback")) == "yes", timeout=5,
                      interval=0.05, what="the plugin's callback to start")
        r = str(fppd.command("Native Test Remove Callback", timeout=15))
        time.sleep(2.5)
    assert r == "waited", f"RemoveCallback returned while the callback was still running ({r})"


def test_unregistering_a_variable_listener_waits_for_its_run(fppd):
    """Variables::unregisterListener() called while the listener is running
    on another thread returns only after that run ends.

    Regression: 4a1d2280a. Listeners ran outside the lock with nothing
    counting them, so unregisterListener() returned while one was still
    running, and its owner could free what it used."""
    install(fppd, features=["NATIVE_VARIABLES"])
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "Watch", "command": "Set Variable", "presetSlot": 0,
        "args": ["Watched", "Value", "1", "1", "0", "100", ""]}]})
    fppd.start()
    # From the main loop: a listener run on an HTTP thread holds that
    # thread's event loop, and later requests assigned to it would wait too.
    fppd.command("Trigger Command Preset In Future", "watch", "100", "Watch")
    fppd.wait_for(lambda: str(fppd.command("Native Test In Listener")) == "yes", timeout=5,
                  interval=0.05, what="the plugin's listener to start")
    r = str(fppd.command("Native Test Unregister", timeout=15))
    time.sleep(2.5)
    assert r == "waited", f"unregisterListener returned while the listener was still running ({r})"



def test_unregistering_a_settings_listener_waits_for_its_run(fppd):
    """unregisterSettingsListener() called while the listener is running on
    another thread returns only after that run ends, so its owner can free
    what the listener captured (DPIPixels' listener writes into the output
    an output reload deletes).

    Regression: b868864d3. Since e1bee3f47 listeners are called from a copy
    with no settings lock held, and nothing counted the calls, so the
    unregister returned while the listener was still running."""
    install(fppd, features=["NATIVE_SETTINGS"])
    fppd.start()
    time.sleep(1.1)  # the edit lands in a later second than fppd's own writes
    # A settings file edit is reloaded on the main loop, which calls the
    # listener there; the unregister below runs on an HTTP thread.
    fppd.settings(fpptestWatched="1")
    fppd.wait_for(lambda: str(fppd.command("Native Test In Setting Listener")) == "yes",
                  timeout=10, interval=0.05, what="the plugin's settings listener to start")
    r = str(fppd.command("Native Test Unregister Setting", timeout=15))
    time.sleep(2.5)
    assert r == "waited", \
        f"unregisterSettingsListener returned while the listener was still running ({r})"

VERSIONED = r"""
#include <stdio.h>
#include <stdlib.h>
int fpp_plugin_api_version(void) { return API_VERSION; }
void* createPlugin(void) {
    const char* p = getenv("FPP_TEST_PROBE");
    FILE* f = p ? fopen(p, "a") : NULL;
    if (f) { fputs(BUILD "\n", f); fclose(f); }
    return NULL;
}
"""


def versioned_library(fppd, build, out, nodelete=True):
    """A plugin library that records which build it is each time fppd calls
    its createPlugin() (and then declines, so it is never kept)."""
    import re
    import subprocess
    with open(os.path.join(os.environ["FPP_TREE"], "src", "Plugin.h")) as f:
        api = re.search(r"#define FPP_PLUGIN_API_VERSION (\d+)", f.read()).group(1)
    src = out + ".c"
    with open(src, "w") as f:
        f.write(VERSIONED)
    flags = ["-Wl,-z,nodelete"] if nodelete else []
    subprocess.run(["gcc", "-shared", "-fPIC", f"-DAPI_VERSION={api}", f'-DBUILD="{build}"',
                    *flags, "-o", out, src], check=True)


def reload_after_upgrade(fppd, nodelete):
    """Load build 1, replace the file with build 2 (an upgrade: new inode),
    load, then load again with the file unchanged. Returns the builds whose
    createPlugin() ran, in order."""
    from test_plugin_scripts import plugin, probe
    d = plugin(fppd, name="fpp-native", types="c++:probe.so")
    log = os.path.join(fppd.media, "tmp", "probe.log")
    versioned_library(fppd, "v1", os.path.join(d, "probe.so"), nodelete)
    versioned_library(fppd, "v2", os.path.join(d, "probe-v2.so"), nodelete)
    fppd.start(extra_env={"FPP_TEST_PROBE": log})
    fppd.wait_for(lambda: probe(log), timeout=10, what="the plugin to load at startup")
    os.rename(os.path.join(d, "probe-v2.so"), os.path.join(d, "probe.so"))
    for _ in range(2):
        try:
            fppd.post("/fppd/plugin/fpp-native/load", {}, timeout=40)
        except urllib.error.HTTPError:
            pass  # createPlugin() declines every time
    return probe(log)


def test_reloading_an_unchanged_plugin_keeps_the_upgraded_build(fppd):
    """After a plugin library is replaced on disk and loaded, loading it
    again unchanged runs the new build, not the original one.

    Regression: 59c803d43. The replaced file was opened under a private
    name, but only its inode was recorded, so the next load of the same
    file opened the plain path -- still bound in the loader to the first
    build ever loaded from it (a NODELETE library stays mapped): a second
    reload after an upgrade silently went back to the old code."""
    builds = reload_after_upgrade(fppd, nodelete=True)
    assert builds == ["v1", "v2", "v2"], builds
