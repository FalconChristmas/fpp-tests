"""What fppd's orderly shutdown (SIGTERM) stops before it frees what those
things use: the MQTT status publisher thread before the scheduler and
sequence are deleted, and the main loop's epoll set before the plugins that
put descriptors in it are unloaded."""

import os
import shutil
import subprocess
import time

import pytest

import plugin_build
import shims
from fppd import describe_rc


def stopped_cleanly(fppd, timeout=60):
    rc = fppd.stop(timeout=timeout)
    fppd.exit_expected = True
    assert rc == 0, f"fppd exited with {describe_rc(rc)} on SIGTERM\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)


def test_mqtt_status_publisher_is_stopped_before_the_scheduler_is_freed(fppd):
    """The periodic MQTT status publish (MQTTStatusFrequency 1) is held
    part-way through building a status (status_buildhold.so, on the
    FPP-Events thread) as fppd is stopped, and the main thread is held at
    the variables save that follows the scheduler and sequence deletes
    (slowflock.so): fppd still exits 0, because shutdown waits for the
    publisher to finish before it frees anything.

    Regression: b999ca98e. Shutdown only cleared the thread's run flag and
    never joined it, so a publish in progress carried on into the deletes
    and built its status from the freed (now null) scheduler: a SIGSEGV
    in shutdown, the crash handler and exit 255 rather than 0."""
    if not shutil.which("mosquitto"):
        pytest.skip("mosquitto is not installed")
    port = "18831"
    broker = subprocess.Popen(["mosquitto", "-p", port], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(0.5)
        hold = os.path.join(fppd.media, "tmp", "buildhold")
        flag = os.path.join(fppd.media, "tmp", "slowflock")
        fppd.settings(MQTTHost="127.0.0.1", MQTTPort=port, MQTTStatusFrequency="1")
        fppd.start(preload=[shims.build("status_buildhold.c"), shims.build("slowflock.c")],
                   extra_env={"STATUS_BUILDHOLD_FILE": hold,
                              "STATUS_BUILDHOLD_THREAD": "FPP-Events",
                              "STATUS_BUILDHOLD_MS": "4000",
                              "SLOWFLOCK_SUFFIX": "/config/variables.json",
                              "SLOWFLOCK_FLAG": flag,
                              "SLOWFLOCK_MS": "8000"})
        open(hold, "w").close()
        fppd.wait_for(lambda: os.path.exists(hold + ".held"), timeout=15, interval=0.02,
                      what="the MQTT status publish to be held")
        open(flag, "w").close()
        stopped_cleanly(fppd)
        assert not os.path.exists(flag), "the variables save was never held, so this proves nothing"
    finally:
        broker.terminate()
        broker.wait(timeout=10)


def test_plugin_descriptors_withdrawn_after_the_epoll_set_is_closed(fppd):
    """A native plugin with descriptors in the main loop's epoll set
    (epollplugin.cpp) is unloaded at shutdown, after the main loop has
    closed that set: withdrawing them is skipped, not tried on the closed
    set, so the General debug log has no "Failed to remove descriptor".

    Regression: 547358475. removeFileDescriptor() called epoll_ctl() on the
    closed set (descriptor -1) for each one and logged the EBADF it got --
    a warning on every stop of a box with such a plugin (a debug line since
    1a5f596e1)."""
    fppd.settings(LogLevel_General="debug")
    plugin_build.build_and_install(fppd, "epollplugin.cpp", "fpp-epoll")
    fppd.start(extra_env={"EP_MODE": "batch"})
    fppd.wait_for(lambda: "fpp-epoll Counts" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")
    stopped_cleanly(fppd)
    log = fppd.log()
    assert "Main Loop complete" in log, "the debug log of the shutdown is missing, so this proves nothing"
    assert "Failed to remove descriptor" not in log, \
        "\n".join(l for l in log.splitlines() if "descriptor" in l)
