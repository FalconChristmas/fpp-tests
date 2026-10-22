"""The scheduler against the other threads that reach into it: API requests
reloading and reading the schedule, and scheduled commands still running
when fppd stops. The races are TSan's to see (run with --flavor tsan); under
the other builds those check only that fppd keeps answering."""

import os
import subprocess
import threading
import time

from fseq import _sanitizer_flags, solid_frames
from show import CHANNELS, install
from test_plugin_scripts import plugin
from test_scheduler import reload_schedule, schedule_entry, window


def test_reloads_while_the_schedule_is_read(fppd):
    """The API reloads the schedule over and over while other requests read
    it; fppd keeps answering and nothing races.

    Regression: 3fe0c2d3e. The reload cleared the "schedules extend beyond
    the schedule distance" flag before taking the schedule lock, while
    GET /fppd/schedule read it under the lock (TSan: data race)."""
    install(fppd, solid_frames(20, CHANNELS, 55))
    start, end = window(300, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.start()
    stop = threading.Event()
    errors = []

    def read():
        while not stop.is_set():
            try:
                fppd.get("/fppd/schedule", timeout=10)
            except Exception as e:  # noqa: BLE001 -- reported below
                errors.append(e)
                return

    reader = threading.Thread(target=read)
    reader.start()
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            reload_schedule(fppd)
            time.sleep(0.05)
    finally:
        stop.set()
        reader.join()
    assert not errors, errors
    assert fppd.get("/fppd/schedule")["schedule"]["entries"], "the schedule did not survive the reloads"


def test_reloads_from_the_api_while_the_scheduler_runs(fppd):
    """Reloads asked for from the API, one after another, while the
    scheduler's loop runs; fppd keeps answering and nothing races. Nothing
    else reads the schedule meanwhile: a request that takes the schedule lock
    would order the API's write before the loop's read, hiding the race.

    Regression: 2fdad02bf. The reload flag was a plain bool, set by the API's
    reload and read and cleared by the scheduler's own loop (TSan: data
    race on m_loadSchedule)."""
    install(fppd, solid_frames(20, CHANNELS, 55))
    start, end = window(300, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.start()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        reload_schedule(fppd)
        time.sleep(0.3)
    assert fppd.get("/fppd/schedule")["schedule"]["entries"], "the schedule did not survive the reloads"


def slow_command_plugin(fppd, name="fpp-slowcmd"):
    """Build schedule_slowcmd.cpp into a native plugin, as native_plugin.py
    builds nativeplugin.cpp."""
    d = plugin(fppd, name=name, types="c++")
    src = os.path.join(os.environ["FPP_TREE"], "src")
    cmd = ["c++", "-std=gnu++20", "-O1", "-g", "-fPIC", "-shared",
           *_sanitizer_flags(os.path.join(src, "libfpp.so")),
           f'-DPLUGIN_NAME="{name}"', f"-I{src}", "-I/usr/include/jsoncpp",
           os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule_slowcmd.cpp"),
           f"-L{src}", "-lfpp", f"-Wl,-rpath,{src}", "-o", os.path.join(d, f"lib{name}.so")]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("building the plugin failed:\n" + r.stderr[-4000:])


def test_a_scheduled_command_running_at_shutdown_finishes(fppd):
    """fppd told to stop while a scheduled command is still running lets the
    command finish before it tears down what the command may be using.

    Regression: 9502ff86c. Scheduled commands run on detached threads that
    nothing tracked; shutdown went straight on to destroy media, outputs,
    plugins and the command registry beneath a command still running (here
    one that takes 1.8 s, inside the 2 s shutdown now waits), and the process
    exited part-way through it."""
    slow_command_plugin(fppd)
    done = os.path.join(fppd.media, "tmp", "slowcmd-done")
    when, _ = window(6, 7)
    today = when.strftime("%Y-%m-%d")
    fppd.write("config/schedule.json", [{
        "enabled": 1, "day": 7, "playlist": "", "command": "Slow Test Command",
        "args": [done, "1800"], "multisyncCommand": False, "multisyncHosts": "",
        "startTime": when.strftime("%H:%M:%S"), "endTime": when.strftime("%H:%M:%S"),
        "startDate": today, "endDate": today, "repeat": 0, "stopType": 0}])
    fppd.start()
    fppd.wait_for(lambda: os.path.exists(done + ".started"), timeout=30, interval=0.05,
                  what="the scheduled command to start")
    rc = fppd.stop()
    fppd.exit_expected = True
    assert os.path.exists(done), f"fppd exited ({rc}) in the middle of the scheduled command"
    assert rc == 0, f"fppd exited with {rc} on SIGTERM\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
