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


@contextlib.contextmanager
def http_server(routes):
    """A local HTTP server answering GETs/POSTs from `routes` (path -> body);
    yields the list of (method, path, body) requests it got."""
    got = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def _answer(self, method):
            n = int(self.headers.get("Content-Length") or 0)
            got.append((method, self.path, self.rfile.read(n).decode() if n else ""))
            body = routes.get(self.path.split("?")[0], "ok").encode()
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
    on; one with action "remove" takes that remap away again (4f13d1049
    stopped repeats leaking and stacking processors)."""
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
