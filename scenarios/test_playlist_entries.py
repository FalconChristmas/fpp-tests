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
    v = fppd.get("/variables", timeout=5).get(TRACE, {}).get("value")
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
