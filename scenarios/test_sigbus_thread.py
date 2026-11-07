"""A SIGBUS on a thread other than fppd's main one, as a video consumer thread
gets when a DRM buffer goes away: fppd loses that thread and keeps the show
running. tools/sigbusplugin.cpp raises it."""

import pytest

import throw_plugin
from fppd import sanitizer

# The sanitizers' own SIGBUS handling, and TSan's deferred signals, are not what
# a player runs.
pytestmark = pytest.mark.skipif(sanitizer() == "tsan", reason="TSan defers the signal; see above")


def test_a_sigbus_on_another_thread_ends_only_that_thread(fppd):
    """fppd answers the request whose thread died, is still running and serving
    its API, and warns that the video thread crashed."""
    throw_plugin.install(fppd, source="sigbusplugin.cpp", name="fpp-sigbus")
    fppd.start()
    assert fppd.get("/sigbus/thread", timeout=60) == "survived"
    fppd.check_alive()
    assert fppd.get("/fppd/status").get("status_name") == "idle"
    fppd.wait_for(lambda: any("Video thread crashed (SIGBUS)" in w for w in fppd.get("/fppd/warnings")),
                  timeout=10, what=f"the warning; have {fppd.get('/fppd/warnings')}")
    assert "terminating thread only" in fppd.log()
