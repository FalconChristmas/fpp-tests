"""Timers whose callbacks stop or replace their own timer, from a native
plugin (timerplugin.cpp) built against the tree under test the way
native_plugin.py builds nativeplugin.cpp."""

import os
import subprocess
import time

from fseq import _sanitizer_flags
from test_plugin_scripts import plugin

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = "fpp-timertest"


def install(fppd):
    d = plugin(fppd, name=NAME, types="c++")
    src = os.path.join(os.environ["FPP_TREE"], "src")
    cmd = ["c++", "-std=gnu++20", "-O1", "-g", "-fPIC", "-shared",
           *_sanitizer_flags(os.path.join(src, "libfpp.so")),
           f"-I{src}", "-I/usr/include/jsoncpp", os.path.join(HERE, "timerplugin.cpp"),
           f"-L{src}", "-lfpp", f"-Wl,-rpath,{src}", "-o", os.path.join(d, f"lib{NAME}.so")]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("building the timer test plugin failed:\n" + r.stderr[-4000:])
    return d


def test_periodic_timer_that_stops_or_replaces_itself(fppd):
    """A periodic timer whose callback stops itself, or re-adds itself with
    a new callback, finishes that callback with what it captured intact.

    Regression: 0a3e54ce5. Callbacks ran out of the TimerInfo still in the
    timer list: stopping the timer deleted it, and re-adding replaced its
    std::function, while that function was running -- an ASan
    heap-use-after-free on the captured state."""
    install(fppd)
    fppd.start()
    fppd.command("Timer Test Self Stop", "20")
    fppd.command("Timer Test Self Readd", "20")
    fppd.wait_for(lambda: int(str(fppd.command("Timer Test Ran"))) >= 40, timeout=10,
                  what="every timer's callback to finish")
    time.sleep(0.5)
    assert int(str(fppd.command("Timer Test Ran"))) == 40
