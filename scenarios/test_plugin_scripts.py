"""Script plugins: a plugin directory with a callbacks script (run through
scripts/eventScript) that fppd asks for its callback types at startup and
then runs on lifecycle and playlist events, and plugin commands declared in
commands/descriptions.json.

The plugins here write what they were called with to a log in their own
directory, which the scenario reads back.
"""

import json
import os
import time
import urllib.error

import pytest

import pytest

from test_playlist_entries import pause, playlist, step

CALLBACKS = """#!/bin/bash
# Logs every call, one line each, next to itself.
LOG="$(dirname "$0")/events.log"
case "$1" in
    --list)
        LIST_DELAY
        echo "LIST"
        ;;
    --type)
        shift
        echo "$*" >> "$LOG"
        ;;
esac
"""


def plugin(fppd, name="fpp-test", types="playlist,lifecycle", list_delay="", script="callbacks.sh",
           extra=None):
    """Install a script plugin; return its directory."""
    d = os.path.join(fppd.media, "plugins", name)
    os.makedirs(d, exist_ok=True)
    body = CALLBACKS.replace("LIST_DELAY", list_delay or ":").replace("LIST", types)
    path = os.path.join(d, script)
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, 0o755)
    for rel, content in (extra or {}).items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(content if isinstance(content, str) else json.dumps(content))
        os.chmod(p, 0o755)
    return d


def events(d):
    try:
        with open(os.path.join(d, "events.log")) as f:
            return [l.rstrip("\n") for l in f]
    except FileNotFoundError:
        return []


def playlist_actions(d):
    """The Action of each playlist event, in order."""
    out = []
    for line in events(d):
        if line.startswith("playlist --data "):
            out.append(json.loads(line[len("playlist --data "):])["Action"])
    return out


def test_lifecycle_and_playlist_events(fppd):
    """A plugin hears "startup" when fppd loads it, the playlist's start,
    each entry it plays and its stop, and "shutdown" when fppd exits.

    Also covers 00b23cca5: a fresh start was announced as "playing", never
    "start", because the status was set to playing before Start() read it.

    Also covers ad520d0b3: the plugin's directory, "fpp-test", has no dot in
    its name, and the startup scan skipped every such directory, so no user
    plugin loaded and the startup event never came."""
    d = plugin(fppd)
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(1), step(2)]))
    fppd.start()
    fppd.wait_for(lambda: "lifecycle startup" in events(d), timeout=10,
                  what="the startup lifecycle event")
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: "stop" in playlist_actions(d), timeout=20,
                  what="the playlist's stop event")
    acts = playlist_actions(d)
    assert acts[0] == "start" and acts.count("playing") >= 3, acts
    rc = fppd.stop()
    fppd.exit_expected = True
    assert rc == 0, f"fppd exited {rc}"
    assert events(d)[-1] == "lifecycle shutdown", events(d)[-3:]


def test_plugin_command_runs_its_script(fppd):
    """A command declared in commands/descriptions.json is listed with fppd's
    commands and runs its script with the arguments and the plugin's
    directories in the environment."""
    d = plugin(fppd, extra={
        "commands/descriptions.json": [{"name": "Test Plugin Hello", "script": "hello.sh",
                                        "args": [{"name": "who", "type": "string"},
                                                 {"name": "n", "type": "int"}]}],
        "commands/hello.sh": "#!/bin/sh\necho \"$1|$2|$MEDIADIR|$SCRIPTDIR\" > \"$(dirname \"$0\")/hello.out\"\n",
    })
    fppd.start()
    names = [c["name"] for c in fppd.get("/commands")]
    assert "Test Plugin Hello" in names
    fppd.command("Test Plugin Hello", "world", "3")
    out = os.path.join(d, "commands", "hello.out")
    fppd.wait_for(lambda: os.path.exists(out), timeout=10, what="the command script to run")
    who, n, media, scriptdir = open(out).read().strip().split("|")
    assert (who, n) == ("world", "3")
    assert os.path.realpath(media) == os.path.realpath(fppd.media), media
    assert os.path.realpath(scriptdir) == os.path.realpath(os.path.join(d, "commands")), scriptdir


def open_fds(fppd):
    return len(os.listdir(f"/proc/{fppd.proc.pid}/fd"))


def test_unload_and_reload_leaves_nothing_behind(fppd):
    """Unloading a script plugin over the API ends it ("shutdown"), loading
    it again starts it, and doing that over and over leaks no descriptors.

    Regression: 5afbabf7d. Each load read the plugin's callback list through a pipe
    and never closed its end of it: one descriptor for every load.
    """
    d = plugin(fppd)
    fppd.start()
    fppd.wait_for(lambda: "lifecycle startup" in events(d), timeout=10, what="startup")

    def cycle():
        r = fppd.post("/fppd/plugin/fpp-test/unload", {})
        assert r["loaded"] is False, r
        r = fppd.post("/fppd/plugin/fpp-test/load", {})
        assert r["loaded"] is True, r

    cycle()
    assert events(d)[-2:] == ["lifecycle shutdown", "lifecycle startup"], events(d)
    before = open_fds(fppd)
    for _ in range(20):
        cycle()
    assert open_fds(fppd) - before < 5, f"{open_fds(fppd) - before} descriptors leaked over 20 reloads"


def test_a_plugin_that_never_answers_does_not_stop_fppd_starting(fppd):
    """fppd starts even when a plugin's callbacks script hangs on --list.

    Regression: 5afbabf7d. fppd read the plugin's answer with no time limit, at
    startup, so one plugin stuck there (waiting on a network, say) kept fppd
    from ever starting.
    """
    plugin(fppd, "fpp-stuck", list_delay="sleep 600")
    d = plugin(fppd, "fpp-good")
    fppd.start(timeout=60)
    fppd.wait_for(lambda: "lifecycle startup" in events(d), timeout=10,
                  what="the other plugin to load")


def test_unloading_a_plugin_during_another_plugins_callback(fppd):
    """A plugin unloaded while another plugin's playlist callback is running
    off the main loop (here a stop that came in over MQTT, on mosquitto's
    thread) is not called after it is gone.

    Regression: 26915a4d9. Playlist callbacks walked the plugin list on the
    thread that changed the playlist, with no lock, while unload edited the
    list on the main loop and deleted the plugin at once. A walk that was
    inside a slow plugin's callback then called the next plugin out of its
    stale copy of the list: a freed object."""
    import threading
    from test_mqtt_control import HOST, PORT, broker, publish
    slow = plugin(fppd, name="fpp-test-a")
    with open(os.path.join(slow, "callbacks.sh"), "w") as f:
        f.write(CALLBACKS.replace("LIST_DELAY", ":").replace("LIST", "playlist")
                .replace('echo "$*" >> "$LOG"',
                         'echo "$*" >> "$LOG"; case "$*" in *\\"stop\\"*) sleep 3;; esac'))
    plugin(fppd, name="fpp-test-b")
    fppd.write("playlists/P.json", playlist("P", main=[pause(60)]))
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        time.sleep(2)  # connected and subscribed
        for _ in range(3):
            # Unload and reload first, so B is listed after A whatever order
            # the plugin directories were read in at startup.
            assert fppd.post("/fppd/plugin/fpp-test-b/unload", {}, timeout=40)["loaded"] is False
            assert fppd.post("/fppd/plugin/fpp-test-b/load", {}, timeout=40)["loaded"] is True
            fppd.command("Start Playlist", "P", "false", "false", timeout=30)
            fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                          timeout=20, what="the playlist to start")
            n = len(events(slow))
            publish("set/playlist/P/stop/now")
            fppd.wait_for(lambda: any('"stop"' in l for l in events(slow)[n:]), timeout=10,
                          what="fpp-test-a's stop callback to start")
            r = fppd.post("/fppd/plugin/fpp-test-b/unload", {}, timeout=40)
            assert r["loaded"] is False, r
            time.sleep(4)  # fpp-test-a's callback returns; the walk goes on to B
            assert fppd.post("/fppd/plugin/fpp-test-b/load", {}, timeout=40)["loaded"] is True


def test_unload_mid_walk_waits_only_for_its_own_plugin(fppd):
    """Unloading a plugin while a playlist callback walk is inside another
    plugin's slow callback returns at once, and the walk then skips the
    unloaded plugin instead of calling it.

    Regression: 0bbbe2772. 26915a4d9 counted every plugin in the walk's copy
    of the list as in flight before calling the first one, so an unload
    landing mid-walk waited -- on the main loop -- for the whole walk,
    including the unrelated plugin's slow callback (up to 30 s), and the
    walk still went on to call the plugin it was unloading. (A script
    plugin logs "shutdown" from its destructor, which ran only after that
    call, so what shows is a playlist event logged after the unload was
    asked for.)

    Regression: e742df13a. 0bbbe2772 took the plugin's Plugin* (a
    dynamic_cast, which reads the object) before checking it was still
    listed; with the unload no longer waiting, the unloaded plugin had
    been freed by then, and the walk crashed in __dynamic_cast."""
    from test_mqtt_control import HOST, PORT, broker, publish
    slow = plugin(fppd, name="fpp-test-a")
    with open(os.path.join(slow, "callbacks.sh"), "w") as f:
        f.write(CALLBACKS.replace("LIST_DELAY", ":").replace("LIST", "playlist")
                .replace('echo "$*" >> "$LOG"',
                         'echo "$*" >> "$LOG"; case "$*" in *\\"stop\\"*) sleep 8;; esac'))
    other = plugin(fppd, name="fpp-test-b")
    fppd.write("playlists/P.json", playlist("P", main=[pause(60)]))
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        time.sleep(2)  # connected and subscribed
        # Unload and reload first, so B is listed after A whatever order the
        # plugin directories were read in at startup.
        assert fppd.post("/fppd/plugin/fpp-test-b/unload", {}, timeout=40)["loaded"] is False
        assert fppd.post("/fppd/plugin/fpp-test-b/load", {}, timeout=40)["loaded"] is True
        fppd.command("Start Playlist", "P", "false", "false", timeout=30)
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                      timeout=20, what="the playlist to start")
        n = len(events(slow))
        # Off the main loop (mosquitto's thread), so the unload can run there
        # while the walk is inside fpp-test-a.
        publish("set/playlist/P/stop/now")
        fppd.wait_for(lambda: any('"stop"' in l for l in events(slow)[n:]), timeout=10,
                      what="fpp-test-a's stop callback to start")
        before = len(events(other))
        began = time.monotonic()
        r = fppd.post("/fppd/plugin/fpp-test-b/unload", {}, timeout=40)
        took = time.monotonic() - began
        assert r["loaded"] is False, r
        assert took < 3, f"unloading fpp-test-b waited {took:.1f} s on fpp-test-a's callback"
        time.sleep(9)  # fpp-test-a's callback returns and the walk finishes
        after = events(other)[before:]
        assert after == ["lifecycle shutdown"], \
            f"fpp-test-b was called after its unload was asked for: {after}"


SLOW_COMMAND = '#!/bin/sh\ntouch "$(dirname "$0")/started"\nsleep SECONDS\ntouch "$(dirname "$0")/done"\n'


def slow_command_plugin(fppd, seconds):
    return plugin(fppd, extra={
        "commands/descriptions.json": [{"name": "Test Plugin Slow", "script": "slow.sh", "args": []}],
        "commands/slow.sh": SLOW_COMMAND.replace("SECONDS", str(seconds)),
    })


def unload_during_command(fppd, d):
    """Run "Test Plugin Slow" from one client and unload its plugin from
    another once the script has started; return (unload's answer, how long
    the unload took, the command's answer or exception)."""
    import threading
    got = {}

    def run():
        try:
            got["r"] = fppd.command("Test Plugin Slow", timeout=40)
        except Exception as e:  # noqa: BLE001 -- reported below
            got["r"] = e

    t = threading.Thread(target=run)
    t.start()
    fppd.wait_for(lambda: os.path.exists(os.path.join(d, "commands", "started")), timeout=10,
                  what="the command's script to start")
    conn = free_http_connection(fppd)
    began = time.monotonic()
    conn.request("POST", "/fppd/plugin/fpp-test/unload", body="{}",
                 headers={"Content-Type": "application/json"})
    conn.sock.settimeout(40)
    r = json.loads(conn.getresponse().read())
    took = time.monotonic() - began
    conn.close()
    t.join(45)
    return r, took, got.get("r")


def free_http_connection(fppd):
    """A kept-alive connection to fppd on an HTTP thread that is not busy.
    drogon spreads connections over its threads, and a request that lands on
    the thread already blocked in a long command waits for that command to
    end first, which is not what a test of overlapping requests means."""
    import http.client
    import socket
    import urllib.parse
    from fppd import API
    host, port = urllib.parse.urlsplit(API).netloc.split(":")
    for _ in range(40):
        conn = http.client.HTTPConnection(host, int(port), timeout=1)
        try:
            conn.request("GET", "/fppd/status")
            conn.getresponse().read()
            return conn
        except (socket.timeout, TimeoutError):
            conn.close()
    raise AssertionError("every HTTP connection to fppd landed on a busy thread")


def test_unloading_a_plugin_waits_for_its_running_command(fppd):
    """Unloading a script plugin while one of its commands is running does
    not free the command under that run, and both requests are answered.

    Regression: 34e2a2efa. Unload deleted the plugin's commands at once, so
    a command still running on an HTTP thread came back from waiting on its
    script into a freed object (it built its "complete" reply from the
    freed name)."""
    d = slow_command_plugin(fppd, 3)
    fppd.start()
    r, took, result = unload_during_command(fppd, d)
    assert r["loaded"] is False, r
    assert not isinstance(result, Exception), result
    assert "Test Plugin Slow complete" in str(result), result
    fppd.check_alive()


def test_unloading_a_plugin_during_a_command_longer_than_the_wait(fppd):
    """Unloading a script plugin while one of its commands runs for longer
    than 10 s neither stalls the unload nor frees the command under the run:
    the command is deleted when its run returns.

    Regression: 2cb6cfc0c. 34e2a2efa made unload wait for the run, but only
    for 10 s, holding the main loop that long; it then deleted the command
    anyway, and the run came back from its 15 s script and built its reply
    from the freed name (an ASan heap-use-after-free)."""
    d = slow_command_plugin(fppd, 15)
    fppd.start()
    r, took, result = unload_during_command(fppd, d)
    assert r["loaded"] is False, r
    assert not isinstance(result, Exception), result
    assert "Test Plugin Slow complete" in str(result), result
    fppd.check_alive()
    assert took < 5, f"the unload took {took:.1f} s: it waited on the running command"


NATIVE_PROBE = r"""
#include <stdio.h>
#include <stdlib.h>
__attribute__((constructor)) static void loaded(void) {
    const char* p = getenv("FPP_TEST_PROBE");
    FILE* f = p ? fopen(p, "a") : NULL;
    if (f) { fputs("loaded\n", f); fclose(f); }
}
"""


def native_probe_plugin(fppd, name="fpp-native"):
    """A plugin whose callbacks answer c++:probe.so, a library that records
    being loaded (it has no createPlugin, so fppd refuses it after that);
    returns the probe file."""
    import subprocess
    d = plugin(fppd, name=name, types="c++:probe.so")
    src = os.path.join(d, "probe.c")
    with open(src, "w") as f:
        f.write(NATIVE_PROBE)
    subprocess.run(["gcc", "-shared", "-fPIC", "-o", os.path.join(d, "probe.so"), src], check=True)
    return os.path.join(fppd.media, "tmp", "probe.log")


def probe(path):
    try:
        with open(path) as f:
            return f.read().split()
    except FileNotFoundError:
        return []


@pytest.mark.parametrize("reinstall", ["1", ""])
def test_native_plugin_is_not_loaded_until_reinstalled_after_fppos(fppd, reinstall):
    """While pluginReinstallNeededAfterOS is set (an FPPOS reflash kept the
    plugin clones, built against the previous FPP), fppd does not load a
    native plugin's library at startup; the Plugin Manager's load after rebuilding it still loads it. With the
    setting empty, the library loads at startup.

    Regression: 080e60347. fppd dlopened the stale library at boot; one
    built against 10.1 headers crashed in its constructor, a boot loop
    before the user could reinstall."""
    log = native_probe_plugin(fppd)
    fppd.settings(pluginReinstallNeededAfterOS=reinstall)
    fppd.start(extra_env={"FPP_TEST_PROBE": log})
    if not reinstall:
        fppd.wait_for(lambda: probe(log) == ["loaded"], timeout=10, what="the library to load")
        return
    time.sleep(2)
    assert probe(log) == [], "the stale native library was loaded at startup"
    assert "Not loading plugin fpp-native" in fppd.log()
    try:
        fppd.post("/fppd/plugin/fpp-native/load", {}, timeout=40)
    except urllib.error.HTTPError:
        pass  # no createPlugin: refused once loaded, which is all this needs
    assert probe(log) == ["loaded"], probe(log)


def test_slow_lifecycle_shutdown_does_not_hold_the_unload(fppd):
    """Unloading a script plugin whose "shutdown" lifecycle script takes 20 s
    (stopping a daemon, say) returns within a few seconds.

    Regression: c30b88f04. The lifecycle script was waited for without a
    bound, on the main loop, so output and every main-loop request stopped
    for as long as it ran."""
    d = plugin(fppd, types="lifecycle")
    with open(os.path.join(d, "callbacks.sh"), "w") as f:
        f.write(CALLBACKS.replace("LIST_DELAY", ":").replace("LIST", "lifecycle")
                .replace('echo "$*" >> "$LOG"',
                         'echo "$*" >> "$LOG"; case "$*" in *shutdown*) sleep 20;; esac'))
    fppd.start()
    fppd.wait_for(lambda: "lifecycle startup" in events(d), timeout=10, what="startup")
    began = time.monotonic()
    r = fppd.post("/fppd/plugin/fpp-test/unload", {}, timeout=40)
    took = time.monotonic() - began
    assert r["loaded"] is False, r
    assert took < 10, f"the unload waited {took:.1f} s for the shutdown script"


def test_shutdown_while_an_mqtt_message_is_being_handled(fppd):
    """fppd stopped (SIGTERM) while the MQTT thread is still handling a
    message -- a playlist stop whose plugin callback takes 8 s -- exits 0.

    Regression: 5cac5ea15. Shutdown stopped the MQTT thread with a forced
    cancel, which landed at the callback's cancellation point (waiting on
    the plugin's script); the catch (...) around message callbacks
    swallowed the forced unwind, and the process aborted ("exception not
    rethrown") instead of exiting."""
    from test_mqtt_control import HOST, PORT, broker, publish
    slow = plugin(fppd, name="fpp-test-a")
    with open(os.path.join(slow, "callbacks.sh"), "w") as f:
        f.write(CALLBACKS.replace("LIST_DELAY", ":").replace("LIST", "playlist")
                .replace('echo "$*" >> "$LOG"',
                         'echo "$*" >> "$LOG"; case "$*" in *\\"stop\\"*) sleep 8;; esac'))
    fppd.write("playlists/P.json", playlist("P", main=[pause(60)]))
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        time.sleep(2)  # connected and subscribed
        fppd.command("Start Playlist", "P", "false", "false", timeout=30)
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                      timeout=20, what="the playlist to start")
        n = len(events(slow))
        publish("set/playlist/P/stop/now")
        fppd.wait_for(lambda: any('"stop"' in l for l in events(slow)[n:]), timeout=10,
                      what="the plugin's stop callback to start")
        rc = fppd.stop(timeout=30)
        fppd.exit_expected = True
    assert rc == 0, f"fppd exited {rc} when stopped mid-callback\n{fppd.tail()}"
    assert not fppd.sanitizer_reports(), fppd.sanitizer_reports()[0][:4000]


@pytest.mark.parametrize("name", [".", "%2E", ".."])
def test_load_route_refuses_a_dot_name(fppd, name):
    """The plugin load route refuses "." and ".." as a plugin name: the
    name becomes a directory under plugins/, and those name the plugin
    directory itself and the media directory. Nothing is run.

    Regression: 4af3c6b3e (HP-14). Only empty names and names with a
    slash were refused, so "." ran plugins/callbacks --list as a plugin's.
    """
    import urllib.error
    ran = os.path.join(fppd.media, "tmp", "ran")
    for d in ("plugins", ""):
        script = os.path.join(fppd.media, d, "callbacks")
        with open(script, "w") as f:
            f.write(f"#!/bin/sh\ntouch '{ran}'\necho playlist\n")
        os.chmod(script, 0o755)
    fppd.start()
    try:
        fppd.post(f"/fppd/plugin/{name}/load", {})
        code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    time.sleep(1)
    assert not os.path.exists(ran), f"loading plugin {name!r} ran a callbacks script"
    assert code == 400, f"loading plugin {name!r} answered {code}"


def slow_stop_plugin(fppd, seconds):
    """A script plugin (playlist and lifecycle events) whose playlist "stop"
    callback takes `seconds` and then logs "stop callback done"; returns its
    directory."""
    d = plugin(fppd, types="playlist,lifecycle")
    with open(os.path.join(d, "callbacks.sh"), "w") as f:
        f.write(CALLBACKS.replace("LIST_DELAY", ":").replace("LIST", "playlist,lifecycle")
                .replace('echo "$*" >> "$LOG"',
                         'echo "$*" >> "$LOG"; case "$*" in *\\"stop\\"*) sleep %s; '
                         'echo "stop callback done" >> "$LOG";; esac' % seconds))
    return d


LEFT_ALIVE = "Plugin fpp-test is still in a playlist callback at shutdown; leaving it"


def test_shutdown_waits_for_a_playlist_callback_on_a_command_thread(fppd):
    """fppd stopped (SIGTERM) while a scheduled "Stop Now" -- run on the
    scheduler's own command thread, not the main loop -- is inside a script
    plugin's 3.5 s playlist "stop" callback waits for the callback before it
    destroys the plugin, and exits 0 with no sanitizer report: the plugin's
    "lifecycle shutdown" event, which its destructor sends, comes after the
    callback's last line, and no plugin is reported left behind.

    Shutdown first waits up to 2 s for scheduled commands
    (Scheduler::WaitForCommandThreads), which this one outlasts; the rest
    of the callback (about 1.4 s) ends inside PluginManager::Cleanup()'s own
    2 s wait.

    Regression: 2867c832e. Cleanup() deleted every plugin at once, without
    waiting for the playlist callbacks in flight: the plugin's "lifecycle
    shutdown" came while its stop callback was still in its script, and
    under TSan the delete raced the call.

    Other threads that run playlist callbacks: an HTTP request's is drained
    when the API server stops, before Cleanup(); an MQTT message's is the
    case of the next test, and of
    test_shutdown_while_mqtts_thread_finishes_a_playlist_callback_inside_the_wait
    for one that ends inside the wait."""
    from test_scheduler import window
    d = slow_stop_plugin(fppd, 3.5)
    fppd.write("playlists/P.json", playlist("P", main=[pause(60)]))
    when, _ = window(8, 9)
    today = when.strftime("%Y-%m-%d")
    fppd.write("config/schedule.json", [{
        "enabled": 1, "day": 7, "playlist": "", "command": "Stop Now", "args": [],
        "multisyncCommand": False, "multisyncHosts": "",
        "startTime": when.strftime("%H:%M:%S"), "endTime": when.strftime("%H:%M:%S"),
        "startDate": today, "endDate": today, "repeat": 0, "stopType": 0}])
    fppd.start()
    fppd.wait_for(lambda: "lifecycle startup" in events(d), timeout=10, what="startup")
    fppd.command("Start Playlist", "P", "false", "false", timeout=30)
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                  timeout=20, what="the playlist to start")
    n = len(events(d))
    fppd.wait_for(lambda: any('"stop"' in l for l in events(d)[n:]), timeout=30,
                  interval=0.02, what="the scheduled stop's plugin callback to start")
    rc = fppd.stop(timeout=60)
    fppd.exit_expected = True
    after = events(d)[n:]
    assert "stop callback done" in after and "lifecycle shutdown" in after, after
    assert after.index("stop callback done") < after.index("lifecycle shutdown"), \
        f"the plugin was destroyed while its stop callback was still running: {after}"
    assert LEFT_ALIVE not in fppd.log()
    assert rc == 0, f"fppd exited {rc} when stopped mid-callback\n{fppd.tail()}"
    assert not fppd.sanitizer_reports(), fppd.sanitizer_reports()[0][:4000]


def test_shutdown_leaves_a_plugin_whose_playlist_callback_outlasts_the_wait(fppd):
    """fppd stopped (SIGTERM) while a script plugin's playlist "stop"
    callback is running on another thread -- a stop that came in over
    MQTT, so it runs on mosquitto's thread -- and runs on past shutdown's
    2 s wait for it (15 s here) leaves that plugin alive, with a warning
    naming it, rather than destroying it under the call: no "lifecycle
    shutdown" event from its destructor. Shutdown waits the 2 s, not the
    whole callback, and fppd exits 0 with no sanitizer report.

    Regression: 2867c832e. PluginManager::Cleanup() deleted every plugin at
    once, without waiting for the playlist callbacks in flight: the plugin's
    "lifecycle shutdown" came while its stop callback was still in its
    script, and under TSan the delete raced the call (fppd exited 66)."""
    from test_mqtt_control import HOST, PORT, broker, publish
    d = slow_stop_plugin(fppd, 15)
    fppd.write("playlists/P.json", playlist("P", main=[pause(60)]))
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: "lifecycle startup" in events(d), timeout=10, what="startup")
        time.sleep(2)  # connected and subscribed
        fppd.command("Start Playlist", "P", "false", "false", timeout=30)
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                      timeout=20, what="the playlist to start")
        n = len(events(d))
        publish("set/playlist/P/stop/now")
        fppd.wait_for(lambda: any('"stop"' in l for l in events(d)[n:]), timeout=10,
                      interval=0.02, what="the plugin's stop callback to start")
        began = time.monotonic()
        rc = fppd.stop(timeout=60)
        took = time.monotonic() - began
        fppd.exit_expected = True
    after = events(d)[n:]
    assert "lifecycle shutdown" not in after, \
        f"the plugin was destroyed while its stop callback was still running: {after}"
    assert LEFT_ALIVE in fppd.log(), fppd.tail()
    assert took < 10, f"shutdown took {took:.1f} s: it waited on the 15 s callback"
    assert rc == 0, f"fppd exited {rc} when stopped mid-callback\n{fppd.tail()}"
    assert not fppd.sanitizer_reports(), fppd.sanitizer_reports()[0][:4000]


def test_shutdown_while_mqtts_thread_finishes_a_playlist_callback_inside_the_wait(fppd):
    """fppd stopped (SIGTERM) while a script plugin's 1.5 s playlist "stop"
    callback -- a stop that came in over MQTT, so on the MQTT client's
    network thread -- is running exits 0 with no sanitizer report. The
    callback ends inside PluginManager::Cleanup()'s 2 s wait, and the
    network thread goes from that message straight into the disconnect the
    MQTT client's destructor queued, so it is busy, not waiting in select,
    when the destructor stops it.

    Regression: f88bf9826. The MQTT client stopped libmosquitto's own
    thread with mosquitto_loop_stop(), which joins only while libmosquitto
    still sees that thread running; the thread clears that itself on the way
    out, and when it got there first loop_stop returned MOSQ_ERR_INVAL and
    joined nothing, so mosquitto_destroy() freed the client under the
    exiting thread (under TSan, pthread_mutex_destroy racing its last locks:
    fppd exited 66)."""
    from test_mqtt_control import HOST, PORT, broker, publish
    d = slow_stop_plugin(fppd, 1.5)
    fppd.write("playlists/P.json", playlist("P", main=[pause(60)]))
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: "lifecycle startup" in events(d), timeout=10, what="startup")
        time.sleep(2)  # connected and subscribed
        fppd.command("Start Playlist", "P", "false", "false", timeout=30)
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                      timeout=20, what="the playlist to start")
        n = len(events(d))
        publish("set/playlist/P/stop/now")
        fppd.wait_for(lambda: any('"stop"' in l for l in events(d)[n:]), timeout=10,
                      interval=0.02, what="the plugin's stop callback to start")
        rc = fppd.stop(timeout=60)
        fppd.exit_expected = True
    after = events(d)[n:]
    assert "stop callback done" in after, after
    assert rc == 0, f"fppd exited {rc} when stopped mid-callback\n{fppd.tail()}"
    assert not fppd.sanitizer_reports(), fppd.sanitizer_reports()[0][:4000]


def test_only_a_native_plugin_that_fails_to_load_raises_a_warning(fppd):
    """A C++ plugin whose library cannot be loaded is reported as "Could not
    load plugin <name>" in fppd's warnings; a script-only plugin, which has
    no library, never is.

    Feature: e9007dfc7. Every plugin without a library was warned about as
    though its missing .so were a failure.
    """
    bad = plugin(fppd, name="fpp-badnative", types="c++")
    with open(os.path.join(bad, "libfpp-badnative.so"), "wb") as f:
        f.write(b"this is not a shared library\n")
    # one with a script and nothing else, and one with no script at all (a
    # plugin that is only web pages): neither has a library
    plugin(fppd, name="fpp-scriptonly", types="playlist,lifecycle")
    os.makedirs(os.path.join(fppd.media, "plugins", "fpp-pageonly"), exist_ok=True)
    with open(os.path.join(fppd.media, "plugins", "fpp-pageonly", "pluginInfo.json"), "w") as f:
        f.write("{}")
    fppd.start()
    fppd.wait_for(lambda: any("Could not load plugin fpp-badnative" in w
                              for w in fppd.get("/fppd/status").get("warnings", [])),
                  timeout=15, what="the native plugin's load warning")
    warnings = fppd.get("/fppd/status").get("warnings", [])
    assert not [w for w in warnings if "fpp-scriptonly" in w or "fpp-pageonly" in w], warnings
