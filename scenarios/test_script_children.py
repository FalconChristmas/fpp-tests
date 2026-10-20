"""What fppd's forked children for scripts do between fork() and exec, and
what happens when fork() itself fails.

fppd is threaded, so a forked child may only make async-signal-safe calls
until it execs: a lock another thread held at the moment of the fork stays
held in the child, which then hangs on it, and whatever waits for that
child (a blocking playlist script entry, the main loop) hangs with it.
forkchild.so makes any such call in a child fail at once and every time,
instead of one run in thousands, and logs what it was.
"""

import os
import time
import urllib.error

import pytest

import shims
from test_playlist_entries import pause, playlist, script, step
from test_plugin_scripts import events, playlist_actions, plugin


def start_watched(fppd, **kw):
    log = os.path.join(fppd.media, "tmp", "forkchild.log")
    fppd.start(preload=[shims.build("forkchild.c")], extra_env={"FORKCHILD_LOG": log}, **kw)
    return log


def caught(log):
    try:
        with open(log) as f:
            return f.read().split()
    except FileNotFoundError:
        return []


def test_script_entry_child_only_execs(fppd):
    """A blocking script entry's child execs the script without taking a
    lock or touching the environment first: the script runs and the
    playlist goes on to the entry after it.

    Regression: 0cfa33573. The child read a setting (a lock), logged (a
    lock) and built its environment with setenv() before exec; with that
    lock held by another thread at the fork, the child never ran the
    script and the blocking entry waited for it for good."""
    from test_commands import command_entry, set_variable, variable
    out = os.path.join(fppd.media, "tmp", "script.out")
    script(fppd, "rec.sh", f"#!/bin/bash\necho ran > {out}\n")
    fppd.write("playlists/P.json", playlist("P", main=[
        {"type": "script", "enabled": 1, "playOnce": 0, "scriptName": "rec.sh",
         "scriptArgs": "a 'b c'", "blocking": True},
        command_entry(set_variable("After", "yes"))]))
    log = start_watched(fppd)
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: variable(fppd, "After") == "yes", timeout=15,
                  what="the entry after the script")
    assert caught(log) == [], f"a script child called {caught(log)} before exec"
    assert os.path.exists(out), "the script never ran"


def test_plugin_children_only_exec(fppd):
    """A script plugin's playlist callbacks and its command run their
    scripts from children that only exec, even with the Plugin log at
    debug (where logging takes the logger's lock).

    Regression: 468449fad. The children built JSON and logged before exec;
    a lock held by another thread at the fork (an MQTT stop runs the
    playlist callbacks on mosquitto's thread) hung the child before its
    script ran, and the caller waited on it for good."""
    d = plugin(fppd, types="playlist", extra={
        "commands/descriptions.json": [{"name": "Test Plugin Hello", "script": "hello.sh", "args": []}],
        "commands/hello.sh": '#!/bin/sh\necho hi > "$(dirname "$0")/hello.out"\n',
    })
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(1)]))
    fppd.settings(LogLevel_Plugin="debug")
    log = start_watched(fppd)
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.command("Test Plugin Hello", timeout=15)
    fppd.wait_for(lambda: caught(log) or "stop" in playlist_actions(d), timeout=15,
                  what="the playlist's stop event")
    assert caught(log) == [], f"a plugin child called {caught(log)} before exec"
    assert os.path.exists(os.path.join(d, "commands", "hello.out")), "the command's script never ran"
    assert playlist_actions(d)[0] == "start", events(d)


def test_plugin_command_when_fork_fails(fppd):
    """A plugin command run while fork() fails (the box out of memory or
    processes) answers with an error, and fppd carries on.

    Regression: 07a590559. The plugin command, media and playlist callbacks
    called exit(EXIT_FAILURE) when fork() failed, from whatever thread ran
    them: fppd quit mid-show over one plugin's command."""
    plugin(fppd, extra={
        "commands/descriptions.json": [{"name": "Test Plugin Hello", "script": "hello.sh", "args": []}],
        "commands/hello.sh": "#!/bin/sh\n",
    })
    flag = os.path.join(fppd.media, "tmp", "failfork")
    log = os.path.join(fppd.media, "tmp", "failfork.log")
    fppd.start(preload=[shims.build("failfork.c")],
               extra_env={"FAILFORK_FLAG": flag, "FAILFORK_LOG": log})
    open(flag, "w").close()
    try:
        fppd.command("Test Plugin Hello", timeout=15)
        pytest.fail("the command reported success with no process to run it in")
    except urllib.error.HTTPError:
        pass
    except (ConnectionError, OSError):
        time.sleep(1)
        fppd.check_alive()  # says how fppd exited
        raise
    finally:
        os.unlink(flag)
    fppd.check_alive()
    assert os.path.exists(log), "fork() was never refused: the shim did not reach the command"
    assert fppd.get("/fppd/status")["fppd"] == "running"
