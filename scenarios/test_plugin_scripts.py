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
    each entry it plays and its stop, and "shutdown" when fppd exits."""
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
