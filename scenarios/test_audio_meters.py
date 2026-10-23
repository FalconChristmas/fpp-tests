"""The audio level meters the PipeWire mixer shows (AudioLevelMonitor).

POST /fppd/meters subscribes a list of PipeWire nodes for a TTL, each as a
sink (what the sink is playing, captured with stream.capture.sink) or as a
playback stream (fppd_stream_N, captured directly). While anything is
subscribed, fppd pushes {"type":"snapshot","data":{"levels":{node: 0-100}}}
on /fppdws about ten times a second; when the TTL lapses without a
re-subscribe, or an empty list is posted, the meters stop and so do the
pushes.

The audio fixture's PipeWire has one null sink, which fppd plays into and
which is the default; a second, silent null sink is loaded here so a meter
pointed at it can be told from one that fell back to the default.
"""

import json
import os
import socket
import subprocess
import time

from audio import write_tone_wav
from wsclient import TEXT, WebSocket

QUIET = "fpp_test_quiet"


def subscribe(fppd, nodes, ttl=6000, timeout=10):
    """nodes: [(name, is_sink)]."""
    return fppd.post("/fppd/meters", {"nodes": [{"name": n, "sink": s} for n, s in nodes],
                                      "ttl": ttl}, timeout=timeout)


def levels_pushed(ws, seconds):
    """[(monotonic time, {node: level})] for every levels snapshot pushed
    within `seconds`; status snapshots are skipped."""
    out = []
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            op, payload = ws.message(timeout=max(end - time.monotonic(), 0.01))
        except socket.timeout:
            break
        if op != TEXT:
            continue
        data = json.loads(payload).get("data", {})
        if "levels" in data:
            out.append((time.monotonic(), data["levels"]))
    return out


def quiet_sink(audio):
    """A second null sink in the scenario's PipeWire, playing nothing."""
    subprocess.run(["pactl", "load-module", "module-null-sink", f"sink_name={QUIET}"],
                   env=audio.env, check=True, capture_output=True, timeout=10)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        out = subprocess.run(["pw-cli", "ls", "Node"], env=audio.env, capture_output=True,
                             text=True).stdout
        if QUIET in out:
            return
        time.sleep(0.2)
    raise AssertionError("the second null sink never appeared")


def test_meters_switched_on_before_anything_played(fppd, audio):
    """Metering switched on before fppd has played anything -- the mixer
    page opened right after a restart -- builds its pipelines and fppd keeps
    answering, through repeated re-subscribes as the page sends them.

    fppd initialises GStreamer in the background as it starts; a shim
    makes that take 5 s (as the first run on a box does, building the
    plugin registry), so the subscription lands before it is done.

    Coverage for ecbaa46e7, whose meter pipeline was built on an
    uninitialised GStreamer and segfaulted (a mixer page crash-looped fppd,
    re-subscribing every 3 s). It does not fail with that guard taken out
    of today's tree: this GStreamer's gst_parse_launch() survives being
    called first."""
    import shims
    fppd.start(preload=[shims.build("aud_slowgstinit.c")], extra_env={"SLOWGSTINIT_MS": "5000"})
    for _ in range(3):
        assert subscribe(fppd, [("fpp_test_sink", True), ("fppd_stream_1", False)],
                         ttl=2000, timeout=20).get("status") == "OK"
        time.sleep(1)
        fppd.get("/fppd/status", timeout=5)
    ws = WebSocket("/fppdws")
    try:
        got = levels_pushed(ws, 2)
    finally:
        ws.close()
    assert got and set(got[-1][1]) == {"fpp_test_sink", "fppd_stream_1"}, \
        f"no levels pushed for the subscribed nodes: {got[-3:]}"


def test_each_meter_reads_its_own_node(fppd, audio):
    """With a tone playing on slot 2, meters on the sink it plays into and
    on its stream (fppd_stream_2, metered as a stream) read the tone, while
    a meter on a second, silent sink reads nothing.

    Regression: 527797e50. Every meter targeted "<node>.monitor", which
    matches nothing in a PipeWire graph; pipewiresrc then fell back to the
    default sink, and every meter read that one signal (all three read 85
    with it put back).

    Coverage for eb1956008: the level is read from the level element's
    rms array in whichever container this GStreamer uses."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 30, amplitude=0.5)
    quiet_sink(audio)
    fppd.start()
    fppd.command("Play Media", "Tone.wav", "1", "0", "2")
    fppd.wait_for(lambda: "fppd_stream_2" in subprocess.run(
        ["pw-cli", "ls", "Node"], env=audio.env, capture_output=True, text=True).stdout,
        timeout=10, what="the slot's stream in the graph")
    ws = WebSocket("/fppdws")
    try:
        nodes = [("fpp_test_sink", True), ("fppd_stream_2", False), (QUIET, True)]
        subscribe(fppd, nodes)
        time.sleep(2)
        subscribe(fppd, nodes)
        got = levels_pushed(ws, 3)
    finally:
        ws.close()
    assert got, "no levels were pushed"
    last = got[-1][1]
    assert last.get("fpp_test_sink", 0) >= 50, f"the playing sink's meter: {last}"
    assert last.get("fppd_stream_2", 0) >= 50, f"the playing stream's meter: {last}"
    assert last.get(QUIET, 100) <= 10, f"the silent sink's meter reads a signal: {last}"


def test_levels_are_pushed_only_while_subscribed(fppd, audio):
    """Levels are pushed on /fppdws about ten times a second while a
    subscription is live, stop once its TTL lapses with no re-subscribe,
    and stop at once when an empty list is posted.

    Feature: 206c48b48."""
    fppd.start()
    ws = WebSocket("/fppdws")
    try:
        subscribe(fppd, [("fpp_test_sink", True)], ttl=3000)
        during = levels_pushed(ws, 2)
        assert len(during) >= 10, f"{len(during)} levels pushes in 2 s"
        time.sleep(2.5)  # past the TTL, with margin for the 20 ms poll
        levels_pushed(ws, 0.5)
        after = levels_pushed(ws, 2)
        assert not after, f"levels still pushed {len(after)} times after the TTL lapsed"

        subscribe(fppd, [("fpp_test_sink", True)], ttl=60000)
        assert levels_pushed(ws, 1), "a fresh subscription pushed nothing"
        subscribe(fppd, [])
        levels_pushed(ws, 0.3)
        stopped = levels_pushed(ws, 1.5)
        assert not stopped, f"levels still pushed {len(stopped)} times after an empty list"
    finally:
        ws.close()


def play_tone_and_meter_it(fppd, audio, ttl):
    """fppd started with a tone playing on slot 2 and its MediaOut debug log
    on, meters on the sink and on the tone's stream for `ttl` ms, and a
    levels push for both seen. Returns the open /fppdws socket."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 120, amplitude=0.5)
    fppd.settings(LogLevel_MediaOut="debug")
    fppd.start()
    fppd.command("Play Media", "Tone.wav", "1", "0", "2")
    fppd.wait_for(lambda: "fppd_stream_2" in subprocess.run(
        ["pw-cli", "ls", "Node"], env=audio.env, capture_output=True, text=True).stdout,
        timeout=30, what="the slot's stream in the graph")
    ws = WebSocket("/fppdws")
    nodes = {"fpp_test_sink", "fppd_stream_2"}
    assert subscribe(fppd, [(n, n == "fpp_test_sink") for n in sorted(nodes)], ttl=ttl,
                     timeout=30).get("status") == "OK"
    got = []
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not any(set(l) == nodes for _, l in got):
        got += levels_pushed(ws, 0.5)
    assert any(set(l) == nodes for _, l in got), f"no levels pushed for both meters: {got[-3:]}"
    return ws


def stop_and_check_clean(fppd):
    """SIGTERM fppd; it must exit 0 within the fixture's usual 30 s, with no
    sanitizer report. Returns fppd's log."""
    rc = fppd.stop(timeout=30)
    fppd.exit_expected = True
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    assert rc == 0, f"fppd exited with {rc} on SIGTERM\n{fppd.tail()}"
    return fppd.log()


def test_meters_left_on_are_stopped_at_shutdown(fppd, audio):
    """With a tone playing and meters on its sink and its stream, still
    subscribed when fppd is told to stop, shutdown stops both meters (the
    log says "stopped metering" for each, after the main loop ends and
    before fppd exits), and fppd exits 0 with no sanitizer report.

    Regression: c1ce7afdb. Nothing called AudioLevelMonitor::Shutdown(),
    so the poll thread kept reading the meters' level elements through the
    whole shutdown and the meters were never stopped; that log line never
    appeared (under ASan and TSan alike; neither reports anything there)."""
    ws = play_tone_and_meter_it(fppd, audio, ttl=600000)
    ws.close()
    log = stop_and_check_clean(fppd)
    ended = log.rfind("Main Loop complete, shutting down.")
    assert ended >= 0, "fppd's log never reached the end of its main loop"
    for node in ("fpp_test_sink", "fppd_stream_2"):
        assert f"AudioLevelMonitor: stopped metering {node}" in log[ended:], \
            f"shutdown never stopped the meter on {node}"


def test_expired_meters_leave_no_thread_behind_at_shutdown(fppd, audio):
    """Meters on a playing tone whose subscription lapses (nobody
    re-subscribes, as when the mixer page is closed) stop, and the levels
    pushes with them; fppd stopped after that exits 0 with no sanitizer
    report.

    Regression: c1ce7afdb, under TSan. The poll thread retires itself once
    its meters expire, and nothing joined it before fppd exited: TSan
    reported it as a thread leak (the thread Subscribe() started). Under
    ASan this passes on both sides."""
    ws = play_tone_and_meter_it(fppd, audio, ttl=1000)
    try:
        # The poll thread stops each expired meter (logging it), then sleeps
        # 20 ms and leaves its loop.
        for node in ("fpp_test_sink", "fppd_stream_2"):
            fppd.wait_for(lambda: f"AudioLevelMonitor: stopped metering {node}" in fppd.log(),
                          timeout=30, what=f"the expired meter on {node} to stop")
        # And the pushes stop: 2 s in a row without one.
        deadline = time.monotonic() + 30
        while levels_pushed(ws, 2):
            assert time.monotonic() < deadline, "levels still pushed 30 s after the TTL lapsed"
    finally:
        ws.close()
    stop_and_check_clean(fppd)
