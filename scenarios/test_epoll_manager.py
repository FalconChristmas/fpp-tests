"""fppd's main loop: EPollManager, the descriptors it watches and the
callbacks it hands their events to, and its wakeup timer. The descriptors
and timers here are a native test plugin's (epollplugin.cpp, built by
plugin_build.py)."""

import time

import plugin_build


def load(fppd, mode):
    plugin_build.build_and_install(fppd, "epollplugin.cpp", "fpp-epoll")
    fppd.start(extra_env={"EP_MODE": mode})
    fppd.wait_for(lambda: "fpp-epoll Counts" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")


def counts(fppd):
    return tuple(map(int, str(fppd.command("fpp-epoll Counts", timeout=10)).split()))


def test_a_descriptor_removed_by_an_earlier_callback_in_the_batch_is_skipped(fppd):
    """Two descriptors become readable together, and the first one's
    callback takes the second out of the epoll set: the second's event, in
    the same batch, is dropped, and fppd carries on.

    Regression: b5d4eb841. waitForEvents() looked the callback up with
    callbacks[fd], which default-constructs an empty std::function for a
    descriptor no longer there; calling it threw std::bad_function_call and
    aborted fppd. Bridge_Initialize() dropping its sockets on an output
    range change, with packets for them in the batch, was the way in."""
    load(fppd, "batch")
    fppd.command("fpp-epoll Fire", timeout=10)
    fppd.wait_for(lambda: counts(fppd)[0] == 1, timeout=10, interval=0.25, what="the first callback to run")
    time.sleep(0.5)
    assert counts(fppd)[1] == 0
    assert fppd.get("/fppd/status", timeout=5)["status_name"]


def test_a_callback_that_removes_its_own_descriptor_finishes(fppd):
    """A callback that takes its own descriptor out of the epoll set, as
    avahi's fpp_watch_free() does, then reads what it captured: it reads it
    intact, and fppd carries on.

    Regression: b5d4eb841. The callback was called in place in the map, so
    removing its own descriptor destroyed the std::function -- and what it
    captured -- while it was still running."""
    load(fppd, "self")
    fppd.command("fpp-epoll Fire", timeout=10)
    fppd.wait_for(lambda: counts(fppd)[0] != 0, timeout=10, interval=0.25, what="the callback to run")
    assert counts(fppd)[0] == 1
    assert fppd.get("/fppd/status", timeout=5)["status_name"]


def test_timers_added_while_fppd_stops(fppd):
    """A plugin thread adding timers, each arming the main loop's wakeup
    timer, while fppd stops and closes it: no sanitizer report (the fixture
    stops fppd with the thread still adding, and checks; under TSan in
    particular).

    Regression: 57d926688. armTimer() used the epoll and timer descriptors
    from whichever thread added the timer, while shutdown() closed them on
    the main thread with no lock between them, so a late timer could use a
    descriptor after it was closed or its number reused."""
    load(fppd, "timers")
    fppd.wait_for(lambda: counts(fppd)[2] > 100, timeout=10, interval=0.25, what="the plugin to add timers")
