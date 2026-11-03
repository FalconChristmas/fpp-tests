"""What a freshly started (or quick-restarted) fppd shows the UI: the log
level it logs at with nothing configured, the fpp-info.json the UI watches
to see a restart finish, and the mode name it reports for a system whose
mode it does not know.
"""

import os

from multisync import ping_packet
from test_command_socket import send as command
from test_multisync_systems import interface, send, wait_listed

INFO_LINE = "Creation of Scheduler, Playlist, and Sequence Complete"
LOOP_LINE = "Starting main processing loop"


def test_default_log_level_is_info(fppd):
    """With no LogLevel settings at all, every logger is at info -- the
    level the Logging settings page shows as the default -- and fppd's Info
    lines are in fppd.log.

    Regression: 16dcb43c4. The built-in default was warn, so a box whose
    settings named no log level logged less than the UI said it would, and
    none of its Info lines."""
    with open(os.path.join(fppd.media, "settings")) as f:
        assert "LogLevel" not in f.read()
    fppd.start()
    levels = fppd.get("/fppd/log").get("log", {})
    assert levels and set(levels.values()) == {"info"}, levels
    fppd.wait_for(lambda: INFO_LINE in fppd.log(), timeout=10,
                  what=f"the Info line {INFO_LINE!r} in fppd.log")


def test_quick_restart_removes_fpp_info(fppd):
    """A quick restart (the "restart" the UI's /api/system/fppd/restart?quick=1
    sends fppd) removes fpp-info.json before fppd re-executes itself, and the
    restarted fppd writes a new one: the UI can tell the restart is done by
    the file coming back.

    The old file is kept by a second hard link, so the removal shows however
    quickly the new fppd writes its file: a new file is a different inode;
    the old file rewritten in place is the same one.

    Regression: 999596473. The file was left in place across the restart,
    so it was there all along and the UI had nothing to wait on."""
    path = os.path.join(fppd.media, "fpp-info.json")
    keep = os.path.join(fppd.media, "tmp", "fpp-info.keep")
    with interface("10.77.0.1"):
        fppd.start()
        fppd.wait_for(lambda: os.path.exists(path), timeout=10, what="fpp-info.json to be written")
        os.link(path, keep)
        command("restart", reply=False)
        fppd.wait_for(lambda: fppd.log().count(LOOP_LINE) >= 2, timeout=60, interval=0.25,
                      what="the restarted fppd to reach its main loop")
        fppd.wait_for(lambda: os.path.exists(path), timeout=10,
                      what="the restarted fppd to write fpp-info.json")
        assert not os.path.samefile(path, keep), \
            "fpp-info.json is the same file as before the restart: it was never removed"
        assert "10.77.0.1" in open(path).read(), open(path).read()


def test_a_quick_restart_keeps_the_log_levels(fppd):
    """Loggers set on fppd's command line keep their levels across a quick
    restart, which re-executes fppd.

    Regression: c6b7ea0ed. The restart ran fppd without the option."""
    with interface("10.77.0.1"):
        fppd.start(argv=[os.path.join(fppd.tree, "src", "fppd"), "-f", "--log-level", "debug:Schedule"])
        assert fppd.get("/fppd/log")["log"]["Schedule"] == "debug"
        command("restart", reply=False)
        fppd.wait_for(lambda: fppd.log().count(LOOP_LINE) >= 2, timeout=60, interval=0.25,
                      what="the restarted fppd to reach its main loop")
        assert fppd.get("/fppd/log")["log"]["Schedule"] == "debug"


def test_unknown_mode_is_named_unknown(fppd):
    """A MultiSync ping from a system announcing a mode fppd does not know
    (0x55) lists that system with fppModeString "unknown", and fppd keeps
    answering.

    Regression: 8ac7da9e8. modeToString() returned NULL for any mode but the
    known ones and UNKNOWN_MODE, and its callers use what it returns: the
    MultiSync system list built a JSON string from the NULL, which today's
    jsoncpp throws on ("Null Value Passed to Value Constructor"), so
    /fppd/multiSyncSystems answered 500 for as long as that system was
    listed (a crash where the NULL was dereferenced)."""
    fppd.start()
    send(ping_packet("10.20.30.85", "odd-mode", version=3, mode=0x55))
    s = wait_listed(fppd, "10.20.30.85")
    assert s["fppMode"] == 0x55, s
    assert s["fppModeString"] == "unknown", s
    assert fppd.get("/fppd/status").get("mode_name") == "player"
