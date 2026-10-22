"""Compiled (C++) plugins: a plugin HTTP route that throws gets a 500, and
fppd keeps running. (What a plugin throws while loading or from
multiSyncData() is in test_native_plugins.py.)

The plugin is tools/throwplugin.cpp, built against the tree under test
(throw_plugin.py).
"""

import time
import urllib.error

import pytest

import throw_plugin


def start(fppd):
    throw_plugin.install(fppd)
    fppd.start()
    fppd.wait_for(lambda: fppd.get("/throw/ok") == "ok", timeout=10, interval=0.2,
                  what="the plugin's routes to answer")


@pytest.mark.parametrize("route", ["/throw/std", "/throw/int"])
def test_a_plugin_route_that_throws_answers_500(fppd, route):
    """A plugin's HTTP handler that throws -- a std::exception or anything
    else -- gets the request a 500, and fppd carries on serving.

    Regression: d9351bd70. Plugin routes are dispatched from drogon's
    default handler, which has no try/catch around it: the exception reached
    the event loop and terminated fppd.

    Also covers 547a957ac, under TSan: drogon's quit() freed the router
    whose default handler had just served these routes while that IO thread
    had not been joined.
    """
    start(fppd)
    for _ in range(3):
        with pytest.raises(urllib.error.HTTPError) as e:
            fppd.get(route)
        assert e.value.code == 500, f"{route} answered {e.value.code}"
    assert fppd.get("/throw/ok") == "ok"

