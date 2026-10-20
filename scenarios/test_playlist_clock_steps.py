"""Playlist waits across a wall-clock step: a pause entry and the pause
between sequences have to be timed on the monotonic clock, or a step back
holds them for the size of the step and a step forward ends them at once.
(Other timers across a step: test_clock_steps.py.)"""

import time

import pytest

from test_clock_steps import STEPS
from test_playlist_entries import pause, playlist, status, step, trace


def started_and_timed(fppd, step_name, want, timeout=8):
    """Start P, step the clock 1 s in, and return how long after the start
    the trace read `want`."""
    fppd.start(fake_time="2026-12-24 18:00:00")
    t0 = time.monotonic()
    fppd.command("Start Playlist", "P", "false", "false")
    time.sleep(1)
    fppd.set_clock(STEPS[step_name])
    fppd.wait_for(lambda: trace(fppd) == want, timeout=timeout, interval=0.05,
                  what=f"{want!r} after the clock stepped {step_name}")
    return time.monotonic() - t0


@pytest.mark.parametrize("step_name", list(STEPS))
def test_pause_entry_across_a_clock_step(fppd, step_name):
    """A 3 s pause entry ends about 3 s after it began, though the wall
    clock steps an hour while it runs.

    Regression: cd9f8e63e. The pause measured its time with the wall clock:
    a step back held it for the hour, a step forward ended it at once.
    """
    fppd.write("playlists/P.json", playlist("P", main=[pause(3), step(1)]))
    took = started_and_timed(fppd, step_name, "1")
    assert 2.5 <= took <= 4.5, f"a 3 s pause took {took:.1f} s"


@pytest.mark.parametrize("step_name", list(STEPS))
def test_pause_between_sequences_across_a_clock_step(fppd, step_name):
    """The 3 s pause between entries ends about 3 s after it began, though
    the wall clock steps an hour while it runs.

    Regression: cd9f8e63e. The pause between sequences measured its time
    with the wall clock, as the pause entry did.
    """
    # The lead-in's reset is an entry too, so the pause comes before step 1.
    fppd.write("playlists/P.json", playlist("P", main=[step(1)], globalPauseBetweenSequencesMS=3000))
    took = started_and_timed(fppd, step_name, "1")
    assert 2.5 <= took <= 4.5, f"a 3 s pause between entries took {took:.1f} s"
