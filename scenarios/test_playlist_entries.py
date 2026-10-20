"""Playlist structure and entry types: lead-in, main and lead-out sections,
loop counts, play-once and disabled entries, sub-playlists, branches,
random order and pauses.

Each entry under test is a command entry that appends one digit to the user
variable "trace" (trace = trace*10 + d), so the order fppd ran them in is
read back from /variables as a string of digits.
"""

import time

import pytest

TRACE = "trace"


def step(d, **extra):
    """A command entry that appends digit d to the trace."""
    e = {"type": "command", "enabled": 1, "playOnce": 0, "command": "Set Variable",
         "args": [TRACE, "Expression", "", "1", "0", "100", f"={TRACE}*10+{d}", "false"]}
    e.update(extra)
    return e


def reset():
    return {"type": "command", "enabled": 1, "playOnce": 0, "command": "Set Variable",
            "args": [TRACE, "Value", "0"]}


def pause(seconds):
    return {"type": "pause", "enabled": 1, "playOnce": 0, "duration": seconds}


def branch(test, true_type="None", false_type="None", **kw):
    e = {"type": "branch", "enabled": 1, "playOnce": 0, "branchTest": test,
         "trueNextBranchType": true_type, "falseNextBranchType": false_type}
    e.update(kw)
    return e


def playlist(name, main=(), lead_in=(), lead_out=(), repeat=0, loop_count=0, **extra):
    """The trace is reset first in the lead-in, so it is a number from the
    start of every run."""
    p = {"name": name, "repeat": repeat, "loopCount": loop_count,
         "leadIn": [reset()] + list(lead_in), "mainPlaylist": list(main),
         "leadOut": list(lead_out)}
    p.update(extra)
    return p


def trace(fppd):
    v = (fppd.get("/variables", timeout=5) or {}).get(TRACE, {}).get("value")
    if v is None:
        return None
    return str(int(float(v))) if v not in ("", "0") else ""


def status(fppd):
    return fppd.get("/fppd/status")


def run(fppd, name, timeout=20, repeat=False):
    """Start the playlist (the command's repeat flag decides whether it
    repeats -- the file's "repeat" does not), wait for it to end, and
    return the trace."""
    fppd.command("Start Playlist", name, "true" if repeat else "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=timeout,
                  interval=0.1, what=f"playlist {name} to finish")
    return trace(fppd)


def test_sections_run_lead_in_main_lead_out(fppd):
    """Lead-in once, the main section, then the lead-out, in order, each
    entry once.

    Regression: the one-pass-a-second hold for repeating playlists of
    instant entries (8249b670a) was also set after the last pass of a
    playlist that does not repeat; when it ran out, the entry then current
    -- the first of the lead-out -- was started a second time. Fixed by
    8be45439e.
    """
    fppd.write("playlists/P.json", playlist("P", lead_in=[step(1)], main=[step(2), step(3)],
                                            lead_out=[step(4)]))
    fppd.start()
    assert run(fppd, "P") == "1234"


def test_loop_count_repeats_only_the_main_section(fppd):
    """loopCount 3 plays the main section three times between one lead-in
    and one lead-out."""
    fppd.write("playlists/P.json", playlist("P", lead_in=[step(1)], main=[step(2), step(3)],
                                            lead_out=[step(4)], repeat=1, loop_count=3))
    fppd.start()
    assert run(fppd, "P", repeat=True) == "1232323" + "4"


def test_disabled_entry_never_runs(fppd):
    """A disabled entry is skipped on every pass. (An entry's "playOnce" is
    written by the editor but never read by fppd, so it isn't tested.)"""
    fppd.write("playlists/P.json", playlist(
        "P", main=[step(1), step(9, enabled=0), step(2)], loop_count=3))
    fppd.start()
    assert run(fppd, "P", repeat=True) == "121212"


def test_sub_playlist_plays_inline(fppd):
    """A playlist entry plays the other playlist's sections (lead-in, main,
    lead-out) in place, then carries on with the next entry."""
    fppd.write("playlists/Sub.json", {
        "name": "Sub", "repeat": 0, "loopCount": 0, "leadIn": [step(5)],
        "mainPlaylist": [step(6)], "leadOut": [step(7)]})
    fppd.write("playlists/P.json", playlist(
        "P", main=[step(1), {"type": "playlist", "enabled": 1, "playOnce": 0, "name": "Sub"}, step(2)]))
    fppd.start()
    assert run(fppd, "P") == "15672"


def test_playlist_that_includes_itself(fppd):
    """A playlist that includes itself as a sub-playlist loads to a bounded
    depth with a warning instead of recursing without end, and still
    plays."""
    fppd.write("playlists/Loop.json", playlist(
        "Loop", main=[step(1), {"type": "playlist", "enabled": 1, "playOnce": 0, "name": "Loop"}]))
    fppd.start()
    out = run(fppd, "Loop", timeout=30)
    assert out and set(out) == {"1"}, f"trace {out!r}"
    assert any("Recursive playlist" in w for w in status(fppd).get("warnings", []))


def test_loop_branch_picks_iterations(fppd):
    """A Loop branch with iterationStart 2 and iterationCount 2 is true on
    the 2nd and 4th pass: there it skips the next entry (an Offset of 2
    rows), elsewhere it falls through."""
    fppd.write("playlists/P.json", playlist(
        "P", main=[branch("Loop", true_type="Offset", trueNextItem=2,
                          iterationStart=2, iterationCount=2),
                   step(2), step(3)],
        repeat=1, loop_count=4))
    fppd.start()
    assert run(fppd, "P", repeat=True) == "23" "3" "23" "3"


@pytest.mark.parametrize("now, expect", [("2026-12-24 18:30:00", "12"), ("2026-12-24 20:30:00", "13")])
def test_time_branch(fppd, now, expect):
    """A Time branch for 18:00-19:00 jumps (Index, rows numbered from 1 as
    the editor shows them) to row 4 inside the window and row 6 outside."""
    # rows: 1 step 1, 2 branch, 3 step 9, 4 step 2, 5 Stop Now, 6 step 3
    fppd.write("playlists/P.json", playlist(
        "P", main=[step(1),
                   branch("Time", true_type="Index", false_type="Index",
                          startTime="18:00:00", endTime="19:00:00",
                          trueNextSection="main", trueNextItem=4,
                          falseNextSection="main", falseNextItem=6),
                   step(9), step(2), {"type": "command", "enabled": 1, "playOnce": 0,
                                      "command": "Stop Now", "args": []},
                   step(3)]))
    fppd.start(fake_time=now)
    assert run(fppd, "P") == expect


@pytest.mark.parametrize("mode", [1, 2])
def test_random_order(fppd, mode):
    """random 1 shuffles the main section once, at load; random 2 shuffles it
    again for every pass. Either way every entry runs exactly once a pass.
    (Five entries, three passes: the trace is a double, exact to 15 digits.)"""
    fppd.write("playlists/P.json", playlist(
        "P", main=[step(d) for d in range(1, 6)], loop_count=3, random=mode))
    fppd.start()
    out = run(fppd, "P", timeout=30, repeat=True)
    passes = [out[i:i + 5] for i in range(0, len(out), 5)]
    assert len(passes) == 3 and all(sorted(p) == list("12345") for p in passes), out
    if mode == 1:
        assert len(set(passes)) == 1, f"random 1 reshuffled between passes: {passes}"
    else:
        # all three alike by chance: 1 in 14400
        assert len(set(passes)) > 1, f"random 2 ran every pass in the same order: {passes[0]}"


def test_pause_entry_takes_its_duration(fppd):
    """A 2 s pause entry holds the playlist for about 2 s, and status shows
    the pause while it runs."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2), step(2)]))
    fppd.start()
    t0 = time.monotonic()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: trace(fppd) == "1", what="the first entry")
    assert trace(fppd) == "1"
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                  what="the playlist to finish")
    took = time.monotonic() - t0
    assert trace(fppd) == "12"
    assert 1.8 <= took <= 4, f"a 2 s pause took {took:.1f} s"


# --- entry types that reach outside the playlist -----------------------------

import contextlib
import http.server
import json
import os
import socketserver
import threading
import urllib.parse


@contextlib.contextmanager
def http_server(routes):
    """A local HTTP server answering GETs/POSTs from `routes` (path -> body,
    or a function returning it); yields the list of (method, path, body)
    requests it got."""
    got = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def _answer(self, method):
            n = int(self.headers.get("Content-Length") or 0)
            got.append((method, self.path, self.rfile.read(n).decode() if n else ""))
            body = routes.get(self.path.split("?")[0], "ok")
            if callable(body):  # a route that does something first (sleeps)
                body = body()
            body = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._answer("GET")

        def do_POST(self):
            self._answer("POST")

        def log_message(self, *a):
            pass

    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield srv.server_address[1], got
    finally:
        srv.shutdown()
        srv.server_close()


def dynamic(sub_type, **kw):
    e = {"type": "dynamic", "enabled": 1, "playOnce": 0, "subType": sub_type, "drainQueue": 0}
    e.update(kw)
    return e


def test_dynamic_entry_from_a_file(fppd):
    """A dynamic entry plays the entries listed in its JSON file, in place."""
    path = fppd.write("tmp/dyn.json", {"mainPlaylist": [step(5), step(6)]})
    fppd.write("playlists/P.json", playlist("P", main=[step(1), dynamic("file", dataFile=path), step(2)]))
    fppd.start()
    assert run(fppd, "P") == "1562"


def test_dynamic_entry_with_a_missing_file(fppd):
    """A dynamic entry whose file is missing (or not JSON) is skipped with a
    warning; the playlist carries on."""
    bad = fppd.write("tmp/bad.json", "this is not json {")
    fppd.write("playlists/P.json", playlist("P", main=[
        step(1), dynamic("file", dataFile=os.path.join(fppd.media, "tmp", "nope.json")),
        dynamic("file", dataFile=bad), step(2)]))
    fppd.start()
    assert run(fppd, "P") == "12"
    warnings = status(fppd).get("warnings", [])
    assert any("Dynamic playlist" in w for w in warnings), warnings


def test_dynamic_entry_from_a_url(fppd):
    """A dynamic entry of subType url fetches its entries over HTTP."""
    body = json.dumps({"mainPlaylist": [step(7), step(8)]})
    with http_server({"/items": body}) as (port, got):
        fppd.write("playlists/P.json", playlist("P", main=[
            step(1), dynamic("url", url=f"http://127.0.0.1:{port}/items"), step(2)]))
        fppd.start()
        assert run(fppd, "P") == "1782"
        assert [p for _, p, _ in got] == ["/items"]


def test_dynamic_entry_from_a_url_too_large(fppd):
    """A dynamic entry whose URL answers with more than CurlManager's 16 MB
    is skipped as a failed request, with that reason, and the playlist
    carries on.

    Regression: 1ce5a48bf. The 16 MB cap (56d07749e) ended the transfer with
    a write error, but the HTTP status still read 200: the entry took the
    first 16 MB as its whole answer, parsed it as JSON ("not valid JSON")
    and wrote all of it into fppd.log.
    """
    body = json.dumps({"mainPlaylist": [step(7), step(8)], "pad": "x" * (20 * 1024 * 1024)})
    with http_server({"/items": body}) as (port, got):
        fppd.write("playlists/P.json", playlist("P", main=[
            step(1), dynamic("url", url=f"http://127.0.0.1:{port}/items"), step(2)]))
        fppd.start()
        assert run(fppd, "P") == "12"
        warnings = status(fppd).get("warnings", [])
        failed = [w for w in warnings if "Dynamic playlist URL request failed" in w]
        assert failed and "larger than 16 MB" in failed[0], warnings
        assert not any("not valid JSON" in w for w in warnings), warnings


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_url_entry_calls_the_url(fppd, method):
    """A URL entry requests its URL (GET, or POST with its data) and then
    the playlist carries on."""
    with http_server({}) as (port, got):
        fppd.write("playlists/P.json", playlist("P", main=[
            step(1), {"type": "url", "enabled": 1, "playOnce": 0, "method": method,
                      "url": f"http://127.0.0.1:{port}/hook?x=1", "data": "payload"},
            step(2)]))
        fppd.start()
        assert run(fppd, "P") == "12"
        fppd.wait_for(lambda: got, what="the URL to be requested")
        m, path, body = got[0]
        assert m == method and path == "/hook?x=1", got
        if method == "POST":
            assert body == "payload"


def script(fppd, name, text):
    path = fppd.write(f"scripts/{name}", text)
    os.chmod(path, 0o755)
    return path


@pytest.mark.parametrize("blocking", [True, False])
def test_script_entry(fppd, blocking):
    """A script entry runs the script with its arguments (quoted ones kept
    whole); a blocking one holds the playlist until it exits, a
    non-blocking one doesn't."""
    out = os.path.join(fppd.media, "tmp", "script.out")
    script(fppd, "rec.sh", f'#!/bin/bash\nsleep 1\nprintf "%s|" "$@" > {out}\n')
    fppd.write("playlists/P.json", playlist("P", main=[
        step(1), {"type": "script", "enabled": 1, "playOnce": 0, "scriptName": "rec.sh",
                  "scriptArgs": "a 'b c' \"d e\"", "blocking": blocking},
        step(2)]))
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: trace(fppd) == "12", timeout=10, what="the playlist to run")
    ran_before_script_ended = not os.path.exists(out)
    fppd.wait_for(lambda: os.path.exists(out) and open(out).read(), timeout=10,
                  what="the script to run")
    assert open(out).read() == "a|b c|d e|"
    if blocking:
        assert not ran_before_script_ended, "the entry after a blocking script ran before it ended"
    else:
        assert ran_before_script_ended, "a non-blocking script held the playlist"


def test_remap_entry_adds_and_removes_a_remap(fppd):
    """A remap entry with action "add" copies channels on the wire from then
    on; one with action "remove" takes that remap away again. (Coverage:
    the stacking that 4f13d1049 fixed needs a repeat, see
    test_repeated_remap_entry_applies_once.)"""
    from ddp import DdpReceiver
    from show import CHANNELS, install, sequence_entry
    frames = [bytes([9] * 6) + bytes(CHANNELS - 6)] * 40  # 2 s
    remap = {"type": "remap", "enabled": 1, "playOnce": 0, "source": 1, "destination": 101,
             "count": 6, "loops": 1, "reverse": 0}
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.write("playlists/R.json", playlist("R", main=[
            dict(remap, action="add"), sequence_entry("Show.fseq"),
            dict(remap, action="remove"), sequence_entry("Show.fseq")]))
        fppd.start()
        fppd.command("Start Playlist", "R", "false", "false")
        fppd.wait_for(lambda: rx.last() and rx.last()[100:106] == bytes([9] * 6),
                      what="the remapped channels")
        fppd.wait_for(lambda: rx.last() and any(rx.last()[:6]) and not any(rx.last()[100:106]),
                      timeout=6, what="the sequence playing with the remap removed")


@contextlib.contextmanager
def fake_plugin(batches):
    """A plugin's playlistCallback.php: prepNextItem starts a PHP-style
    session (a cookie), loadNextItem answers the next batch of entries (an
    empty one when they run out), startedNextItem is a notification. Yields
    the (command, cookie) of every call."""
    calls = []
    left = list(batches)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            cmd = q.get("command", [""])[0]
            calls.append((cmd, self.headers.get("Cookie", "")))
            body = b"ok"
            if cmd == "loadNextItem":
                body = json.dumps({"mainPlaylist": left.pop(0) if left else []}).encode()
            self.send_response(200)
            if cmd == "prepNextItem":
                self.send_header("Set-Cookie", "PHPSESSID=plugin-session; Path=/")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv.server_address[1], calls
    finally:
        srv.shutdown()
        srv.server_close()


def test_dynamic_entry_from_a_plugin(fppd):
    """A dynamic entry of subType plugin asks the plugin's playlist
    callback for its entries -- prepNextItem, then loadNextItem, then
    startedNextItem once they start, in one cookie session -- and with
    drainQueue keeps asking until the plugin has nothing more."""
    with fake_plugin([[step(5), step(6)], [step(7)]]) as (port, calls):
        fppd.write("playlists/P.json", playlist("P", main=[
            step(1), dynamic("plugin", pluginName="fake", pluginHost=f"127.0.0.1:{port}",
                             drainQueue=1),
            step(2)]))
        fppd.start()
        assert run(fppd, "P", timeout=30) == "15672"
        time.sleep(0.5)
    cmds = [c for c, _ in calls]
    assert cmds[:3] == ["prepNextItem", "loadNextItem", "startedNextItem"], cmds
    assert cmds.count("loadNextItem") == 3, cmds  # two batches, then the empty one
    assert all("PHPSESSID=plugin-session" in cookie for c, cookie in calls[1:]), calls


def mark(name):
    return {"type": "command", "enabled": 1, "playOnce": 0, "command": "Set Variable",
            "args": [name, "Value", "1", "1", "0", "100", "", "false"]}


def test_a_restart_resumes_the_scheduled_playlist_where_it_was(fppd):
    """Restarting fppd (the Restart FPPD command) while a scheduled
    playlist plays brings it back at the entry it was on, not at the top:
    the entries before it don't run again. (User variables don't survive
    the restart, so A and B unset afterwards means they weren't re-run.)

    The resume position is the playlist row (e35d8d652, d90b36412)."""
    import datetime
    now = datetime.datetime.now().replace(microsecond=0)
    start, end = now - datetime.timedelta(seconds=60), now + datetime.timedelta(seconds=600)
    if start.date() != end.date():
        pytest.skip("too close to midnight for a same-day window")
    today = start.strftime("%Y-%m-%d")
    fppd.write("playlists/Res.json", {"name": "Res", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": [mark("A"), pause(2), mark("B"), pause(15),
                                                       mark("C")],
                                      "leadOut": []})
    fppd.write("config/schedule.json", [{
        "enabled": 1, "day": 7, "playlist": "Res", "startTime": start.strftime("%H:%M:%S"),
        "endTime": end.strftime("%H:%M:%S"), "startDate": today, "endDate": today,
        "repeat": 0, "stopType": 0}])
    fppd.start()
    fppd.wait_for(lambda: (fppd.get("/variables") or {}).get("B"), timeout=30, interval=0.25,
                  what="the scheduled playlist to reach the long pause")
    time.sleep(1)
    try:
        fppd.command("Restart FPPD")
    except Exception:
        pass  # the answer may not make it out before the restart
    time.sleep(3)

    def answers():
        try:
            return fppd.get("/fppd/status", timeout=2).get("status_name") == "playing"
        except Exception:
            return False
    fppd.wait_for(answers, timeout=60, interval=0.5, what="fppd to come back playing")
    fppd.wait_for(lambda: (fppd.get("/variables") or {}).get("C"), timeout=30, interval=0.5,
                  what="the last entry after the resumed pause")
    assert "Restart: resuming playlist 'Res' at position 3" in fppd.log(), \
        [l for l in fppd.log().splitlines() if "Restart:" in l]
    v = fppd.get("/variables") or {}
    assert "A" not in v and "B" not in v, f"the playlist started over after the restart: {sorted(v)}"


# --- playlist data fppd can only partly read ---------------------------------


def test_reload_with_a_wrong_typed_value_keeps_playing(fppd):
    """A playing playlist whose file is rewritten with a value of the wrong
    type ("repeat": "1") keeps its running copy at the end of the pass,
    with a warning, and plays on.

    Regression: 5ea9e9db4. The end-of-pass reload read the new file with
    asInt(), which throws on a string, and nothing above Process() caught
    it: fppd terminated mid-show.
    """
    p = playlist("P", main=[step(1), pause(3)])
    path = fppd.write("playlists/P.json", p)
    fppd.start()
    fppd.command("Start Playlist", "P", "true", "false")
    fppd.wait_for(lambda: trace(fppd) == "1", what="the first pass")
    fppd.write("playlists/P.json", dict(p, repeat="1"))
    t = time.time() + 5
    os.utime(path, (t, t))  # past the copy fppd loaded, whatever the clock's resolution
    fppd.wait_for(lambda: trace(fppd) == "11", timeout=10, what="the second pass")
    warnings = status(fppd).get("warnings", [])
    assert any("Playlist P is invalid" in w for w in warnings), warnings
    fppd.command("Stop Now")


def test_wrong_typed_entry_is_skipped(fppd):
    """An entry with a value of the wrong type ("enabled": "1") is skipped
    with a warning; the entries after it still load and play.

    Regression: 5ea9e9db4. The entry's Init() threw out of the section
    being loaded, the load stopped there, and only the entries before it
    played.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), step(2, enabled="1"), step(3)]))
    fppd.start()
    assert run(fppd, "P") == "13"
    warnings = status(fppd).get("warnings", [])
    assert any("Invalid playlist entry skipped" in w for w in warnings), warnings


@pytest.mark.parametrize("bad", [{"enabled": "1"}, {"type": {"x": 1}}], ids=["enabled", "type"])
def test_dynamic_entry_with_wrong_typed_data(fppd, bad):
    """A dynamic entry whose data has a value of the wrong type is skipped
    with a warning; the playlist carries on.

    Regression: 5ea9e9db4. jsoncpp threw from the entry's Init() (or from
    reading "type") out of StartPlaying(), on the main loop, and nothing
    caught it: fppd terminated.
    """
    path = fppd.write("tmp/dyn.json", {"mainPlaylist": [step(5, **bad)]})
    fppd.write("playlists/P.json", playlist("P", main=[step(1), dynamic("file", dataFile=path), step(2)]))
    fppd.start()
    assert run(fppd, "P") == "12"
    warnings = status(fppd).get("warnings", [])
    assert any("Dynamic playlist entry is invalid" in w for w in warnings), warnings


def test_dynamic_entry_with_a_disabled_entry(fppd):
    """A disabled entry in a dynamic entry's data is skipped and the next
    one plays.

    Regression: 72a3cb39c. The disabled command finished inside
    StartPlaying() without the command result it would have made, and the
    dynamic entry still called its Process(), which read that null result:
    fppd crashed on the main thread.
    """
    path = fppd.write("tmp/dyn.json", {"mainPlaylist": [step(5, enabled=0), step(6)]})
    fppd.write("playlists/P.json", playlist("P", main=[step(1), dynamic("file", dataFile=path), step(2)]))
    fppd.start()
    assert run(fppd, "P") == "162"


def test_entry_that_neither_starts_nor_finishes_is_skipped(fppd):
    """A random audio entry whose music folder has emptied by the time it
    starts is skipped with a log line, and the playlist carries on.

    Regression: 8aff2cf96. The entry's start returned early without
    finishing it (no file to pick), so it was neither playing nor finished,
    and the playlist stalled on it for good. The one file present at load
    is the one the entry picked then, so at start it looks again and finds
    the folder empty.
    """
    from audio import write_tone_wav
    tone = os.path.join(fppd.media, "music", "Tone.wav")
    write_tone_wav(tone, 1)
    fppd.write("playlists/P.json", playlist("P", main=[
        step(1), pause(2),
        {"type": "media", "enabled": 1, "playOnce": 0, "fileMode": "randomAudio",
         "videoOut": "--Default--"},
        step(2)]))
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: trace(fppd) == "1", what="the first entry")
    os.remove(tone)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15,
                  what="the playlist to get past the media entry")
    assert trace(fppd) == "12"
    assert "entry did not start; skipping it" in fppd.log()


def test_index_branch_counts_rows_not_loaded_entries(fppd):
    """A branch to item 4 lands on the 4th row of the section as the editor
    numbers it, also when an earlier row is a sub-playlist that loads as
    several entries.

    Regression: d90b36412. The item was taken as a position among the
    loaded entries, where the sub-playlist's two entries come first, so the
    branch landed one row short, on step 9.
    """
    fppd.write("playlists/Sub.json", {"name": "Sub", "repeat": 0, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": [step(5), step(6)], "leadOut": []})
    # rows: 1 Sub (5, 6), 2 branch to row 4, 3 step 9, 4 step 2
    fppd.write("playlists/P.json", playlist("P", main=[
        {"type": "playlist", "enabled": 1, "playOnce": 0, "name": "Sub"},
        branch("Loop", true_type="Index", trueNextSection="main", trueNextItem=4,
               iterationStart=1, iterationCount=1),
        step(9), step(2)]))
    fppd.start()
    assert run(fppd, "P") == "562"


def test_script_entry_that_fails_to_start_signals_nothing(fppd):
    """Stopping a playlist whose blocking script entry failed to start (a
    script path fppd refuses) sends no signal at all.

    Regression: a00a041d6. The entry kept RunScript's -1 as its child and
    stayed playing until the next tick; a stop in that window called
    kill(-1, SIGTERM), which as root ends every process on the box but
    init and fppd. Here kill() goes through killguard.so, which blocks and
    logs a pid of -1 or 0; the scenario refuses to run unless the guard is
    shown to be in place.
    """
    import shims
    log = os.path.join(fppd.media, "tmp", "killguard.log")
    fppd.write("playlists/P.json", {"name": "P", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [{"type": "script", "enabled": 1, "playOnce": 0,
                                                      "scriptName": "../nope.sh", "blocking": True},
                                                     pause(5)],
                                    "leadOut": []})
    fppd.start(preload=[shims.build("killguard.c")], extra_env={"KILLGUARD_LOG": log})

    def lines():
        if not os.path.exists(log):
            return []
        with open(log) as f:
            return [l.split(None, 1) for l in f.read().splitlines()]
    pid = str(fppd.proc.pid)
    if not any(p == pid and rest.startswith("selftest blocked") for p, rest in lines()):
        fppd.kill()
        fppd.exit_expected = True
        pytest.fail(f"killguard.so did not engage in fppd, so this can't run safely: {lines()}")
    for _ in range(20):
        fppd.command("Start Playlist", "P", "false", "false")
        fppd.command("Stop Now")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                      what="the playlist to stop")
    blocked = [l for l in lines() if l[0] == pid and not l[1].startswith("selftest")]
    assert not blocked, f"fppd called kill() on a pid of -1 or 0: {blocked}"


def test_global_pause_cut_short_by_a_stop_is_forgotten(fppd):
    """A playlist stopped in its pause between sequences leaves nothing
    behind: the next playlist starts its first entry once.

    Regression: 8aef0c238. The "in the pause" flag survived the stop, and
    the next playlist's first tick took it as the pause ending and started
    its first entry a second time (media restarted, a command ran twice).
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), step(2)],
                                            globalPauseBetweenSequencesMS=3000))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(5), pause(5)], "leadOut": []})
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: trace(fppd) == "1", timeout=10, what="P's first entry, after a pause")
    fppd.command("Stop Now")  # inside the 3 s pause before step 2
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", what="P to stop")
    fppd.command("Set Variable", TRACE, "Value", "0")
    fppd.command("Start Playlist", "Q", "false", "false")
    fppd.wait_for(lambda: trace(fppd) == "5", what="Q's first entry")
    time.sleep(1)
    assert trace(fppd) == "5", "Q's first entry ran twice"
    fppd.command("Stop Now")


def test_dynamic_entry_from_a_slow_url_leaves_fppd_answering(fppd):
    """While a dynamic entry waits on a slow URL, status keeps answering at
    once, and the entries arrive and play when the answer comes.

    Regression: 16f7f37dd. The entry fetched the URL with a blocking request
    inside its start, holding the playlist lock: status stalled for as long
    as the URL took to answer (up to 15 s).
    """
    body = json.dumps({"mainPlaylist": [step(7), step(8)]})

    def slow():
        time.sleep(3)
        return body
    with http_server({"/slow": slow}) as (port, got):
        fppd.write("playlists/P.json", playlist("P", main=[
            step(1), dynamic("url", url=f"http://127.0.0.1:{port}/slow"), step(2)]))
        fppd.start()
        fppd.command("Start Playlist", "P", "false", "false")
        fppd.wait_for(lambda: trace(fppd) == "1", what="the first entry")
        worst = 0
        until = time.monotonic() + 2.5
        while time.monotonic() < until:
            t = time.monotonic()
            status(fppd)
            worst = max(worst, time.monotonic() - t)
            time.sleep(0.1)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20,
                      what="the playlist to finish")
        assert trace(fppd) == "1782"
        assert worst < 1.0, f"status took {worst:.1f} s while the URL was fetched"


def test_repeated_remap_entry_applies_once(fppd):
    """A remap entry in a repeating playlist (channels 1-6 copied onto 4-9,
    overlapping) gives the same output on the second pass as on the first:
    the remap is applied once, not once more per pass.

    Regression: 4f13d1049. Every pass's "add" stacked another identical
    remap processor, so on the second pass the copy ran twice and channels
    7-9 carried A, B, C (already moved once) instead of D, E, F.
    """
    from ddp import DdpReceiver
    from show import CHANNELS, install, sequence_entry
    data = bytes([10, 11, 12, 13, 14, 15])  # A..F
    frames = [data + bytes(CHANNELS - 6)] * 40  # 2 s
    remap = {"type": "remap", "enabled": 1, "playOnce": 0, "action": "add", "source": 1,
             "destination": 4, "count": 6, "loops": 1, "reverse": 0}
    want = bytes([10, 11, 12]) + data  # channels 1-9
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.write("playlists/R.json", playlist("R", main=[remap, sequence_entry("Show.fseq")],
                                                repeat=1, loop_count=3))
        fppd.start()
        fppd.command("Start Playlist", "R", "true", "false")
        fppd.wait_for(lambda: rx.last() and rx.last()[:9] == want, what="the remap on pass 1")
        t0 = time.monotonic()
        time.sleep(4.5)  # through pass 2 (each pass is 2 s)
        later = [d[:9] for t, d in rx.snapshot(since=t0 + 2.5) if any(d[:9])]
    assert later, "nothing on the wire on pass 2"
    bad = [list(d) for d in later if d != want]
    assert not bad, f"channels 1-9 on pass 2: {bad[0]} (want {list(want)})"


def test_instant_loop_warning_once_per_run(fppd):
    """A repeating playlist of instant entries warns once that it is held to
    a pass a second, also when Next Playlist Item moves it on meanwhile.

    Regression: 1827506be. The warned flag was reset in Start(), which
    navigation goes through to restart in place, so every Next logged the
    warning again.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), step(2)]))
    fppd.start()
    fppd.command("Start Playlist", "P", "true", "false")
    line = "repeats with nothing in it that takes time"
    fppd.wait_for(lambda: line in fppd.log(), timeout=10, what="the instant-loop warning")
    for _ in range(3):
        time.sleep(1.5)
        fppd.command("Next Playlist Item")
    time.sleep(1.5)
    fppd.command("Stop Now")
    n = fppd.log().count(line)
    assert n == 1, f"the instant-loop warning was logged {n} times"
