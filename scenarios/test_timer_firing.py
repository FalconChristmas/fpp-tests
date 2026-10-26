"""When fppd's Timers fire, from a native plugin (timerfireplugin.cpp, built
by plugin_build.py against the tree under test): a timer is due at its own
deadline, and a timer armed on an idle fppd wakes the main loop for it
rather than waiting for the loop's next pass."""

import re
import time

import plugin_build


def install(fppd):
    plugin_build.build_and_install(fppd, "timerfireplugin.cpp", "fpp-timerfire")


def test_a_timer_due_exactly_now_fires_in_that_pass(fppd):
    """A one-shot timer runs in a timer pass for exactly its deadline's
    millisecond (where the main loop's wakeup lands), and its callback adding
    another timer -- with the pass's lock released -- runs that one too.
    Repeated, as the main loop's passes are.

    Regression: 0577ed23e. The pass fired only timers whose deadline was
    strictly before now, so the pass at the deadline fired nothing (and,
    having fired nothing, unlocked the timer mutex twice -- by hand and
    again from the unique_lock still owning it; neither ASan nor TSan
    reports that one, so "fired" is what goes red)."""
    install(fppd)
    fppd.start()
    fppd.wait_for(lambda: "Timer Fire Due Now" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")
    for i in range(5):
        assert str(fppd.command("Timer Fire Due Now")) == "fired", f"pass {i}"
    fppd.wait_for(lambda: str(fppd.command("Timer Fire Children")) == "5", timeout=5,
                  what="the timers the callbacks added to fire")


def test_a_timer_on_an_idle_fppd_fires_on_time(fppd):
    """On an idle fppd (its main loop waits 50 ms between passes), a chain
    of one-shot timers each due 5 ms after it is armed runs within a few
    ms of each deadline.

    Regression: e86081470. Timers were only checked when the main loop came
    round, so on an idle fppd a timer ran at the loop's next wake -- here
    about 45 ms late every time -- rather than when it was due. Timers now
    arm a timerfd on the EPollManager loop for the next deadline."""
    install(fppd)
    fppd.start()
    fppd.wait_for(lambda: "Timer Fire Chain" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")
    time.sleep(1)  # startup's own work settles
    assert str(fppd.command("Timer Fire Chain", "20", "5")) == "armed"
    r = fppd.wait_for(lambda: (lambda s: s if s.startswith("done") else None)(
        str(fppd.command("Timer Fire Chain Result"))), timeout=10, interval=0.2,
        what="the chain of timers to finish")
    m = re.match(r"done (\d+) median (-?\d+) max (-?\d+)", r)
    assert m, r
    count, median, worst = (int(x) for x in m.groups())
    assert count == 20
    assert median < 10000, f"timers ran a median {median / 1000:.1f} ms late (worst {worst / 1000:.1f} ms)"
