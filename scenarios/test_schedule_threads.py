"""The scheduler against the other threads that reach into it: API requests
reloading and reading the schedule, and scheduled commands still running
when fppd stops. The races are TSan's to see (run with --flavor tsan); under
the other builds those check only that fppd keeps answering."""

import datetime
import os
import subprocess
import threading
import time

import shims
from fseq import _sanitizer_flags, solid_frames
from show import CHANNELS, install, playlist, status
from test_plugin_scripts import plugin
from test_scheduler import reload_schedule, schedule_entry, wall_of, window


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


def slow_command_plugin(fppd, name="fpp-slowcmd", source="schedule_slowcmd.cpp"):
    """Build schedule_slowcmd.cpp (or another source here) into a native
    plugin, as native_plugin.py builds nativeplugin.cpp."""
    d = plugin(fppd, name=name, types="c++")
    src = os.path.join(os.environ["FPP_TREE"], "src")
    cmd = ["c++", "-std=gnu++20", "-O1", "-g", "-fPIC", "-shared",
           *_sanitizer_flags(os.path.join(src, "libfpp.so")),
           f'-DPLUGIN_NAME="{name}"', f"-I{src}", "-I/usr/include/jsoncpp",
           os.path.join(os.path.dirname(os.path.abspath(__file__)), source),
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


def test_the_calendar_walk_survives_a_reload_that_grows_the_schedule(fppd):
    """GET /fppd/schedule/range held between copying the schedule and walking
    its days (sched_rangehold.so, 3 s) while a reload grows the schedule from
    4 entries to 40; the range answers from its copy and fppd survives.

    Regression: aa65e3307. The day walk indexed the copy by the live
    schedule's size, so once the reload had grown the live schedule it read
    past the end of the copy (ASan: heap-buffer-overflow in
    GetScheduleRange)."""
    day = (datetime.date.today() + datetime.timedelta(days=2)).strftime("%Y-%m-%d")

    def entries(n):
        return [{"enabled": 1, "day": 7, "playlist": "Show",
                 "startTime": f"{10 + i % 10:02d}:00:00", "endTime": f"{10 + i % 10:02d}:30:00",
                 "startDate": day, "endDate": day, "repeat": 0, "stopType": 0}
                for i in range(n)]

    install(fppd, solid_frames(20, CHANNELS, 55))
    fppd.write("config/schedule.json", entries(4))
    held = os.path.join(fppd.media, "tmp", "rangehold")
    # A range start nothing else in fppd converts to local time.
    start = int(time.time()) + 3 * 86400 + 4321
    fppd.start(preload=[shims.build("sched_rangehold.c")],
               extra_env={"SCHED_RANGEHOLD_T": str(start), "SCHED_RANGEHOLD_FILE": held,
                          "SCHED_RANGEHOLD_MS": "3000"})
    assert len(fppd.get("/fppd/schedule")["schedule"]["entries"]) == 4
    answer = {}

    def ask():
        try:
            answer["range"] = fppd.get(f"/fppd/schedule/range?start={start}&end={start + 86400}",
                                       timeout=20)["schedule"]
        except Exception as e:  # noqa: BLE001 -- reported below
            answer["error"] = e

    asker = threading.Thread(target=ask)
    asker.start()
    try:
        fppd.wait_for(lambda: os.path.exists(held), timeout=10, interval=0.02,
                      what="the range request to be held after its copy")
        fppd.write("config/schedule.json", entries(40))
        reload_schedule(fppd)
        fppd.wait_for(lambda: len(fppd.get("/fppd/schedule")["schedule"]["entries"]) == 40,
                      timeout=2.5, interval=0.05, what="the reload to grow the live schedule")
    finally:
        asker.join()
    assert "error" not in answer, f"the range request failed: {answer.get('error')}\n{fppd.tail()}"
    assert len(answer["range"]["entries"]) == 4, "the range did not answer from its own copy"


def test_start_next_scheduled_item_while_a_playlist_command_reads_the_schedule(fppd):
    """A manual playlist whose first entry waits 4 s and then reads the
    schedule is starting from one API request when another asks for Start
    Next Scheduled Item; the scheduled playlist takes over once the manual
    one has started, and fppd keeps answering.

    Regression: af22a8f5e. A playlist entry's command runs inside
    Playlist::Start holding the playlist lock, and a command that reaches the
    scheduler takes the schedule lock after it; Start Next Scheduled Item
    stopped the playing playlist while holding the schedule lock, so the API
    thread and the main loop starting the playlist each held the lock the
    other wanted (a deadlock: fppd wedged)."""
    slow_command_plugin(fppd, name="fpp-schedread", source="schedule_lockcmd.cpp")
    install(fppd, solid_frames(400, CHANNELS, 55))
    done = os.path.join(fppd.media, "tmp", "schedread-done")
    fppd.write("playlists/Manual.json", playlist("Manual", [
        {"type": "command", "enabled": 1, "playOnce": 0, "command": "Slow Schedule Read",
         "args": [done, "4000"]},
        {"type": "pause", "enabled": 1, "playOnce": 0, "duration": 30}]))
    start, end = window(1800, 2400)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.start()
    answers = {}

    def run(key, *command):
        try:
            answers[key] = fppd.command(*command, timeout=20)
        except Exception as e:  # noqa: BLE001 -- reported below
            answers[key] = e

    manual = threading.Thread(target=run, args=("manual", "Start Playlist", "Manual", "false", "false"))
    manual.start()
    fppd.wait_for(lambda: os.path.exists(done + ".started"), timeout=10, interval=0.02,
                  what="the manual playlist's first entry to start")
    time.sleep(0.5)
    nxt = threading.Thread(target=run, args=("next", "Start Next Scheduled Item"))
    nxt.start()
    manual.join(timeout=25)
    nxt.join(timeout=25)
    for key in ("manual", "next"):
        assert not isinstance(answers.get(key), Exception), \
            f"{key}: {answers.get(key)}\n{fppd.tail()}"
    assert os.path.exists(done), "the playlist's command never got the schedule"
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "Show",
                  timeout=10, what="the scheduled playlist to take over")
