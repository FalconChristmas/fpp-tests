"""One-shot pings (PingManager::ping), the kind mDNS discovery sends to every
newly resolved host, driven from a native plugin (pingplugin.cpp)."""

import os
import subprocess
import time

from fseq import _sanitizer_flags
from shims import build
from test_plugin_scripts import plugin

HERE = os.path.dirname(os.path.abspath(__file__))


def install_ping_plugin(fppd, name="fpp-pingtest"):
    """Build pingplugin.cpp into plugins/<name> as a C++ plugin, the way
    native_plugin.install() builds nativeplugin.cpp."""
    d = plugin(fppd, name=name, types="c++")
    src = os.path.join(os.environ["FPP_TREE"], "src")
    cmd = ["c++", "-std=gnu++20", "-O1", "-g", "-fPIC", "-shared",
           *_sanitizer_flags(os.path.join(src, "libfpp.so")),
           f'-DPLUGIN_NAME="{name}"', f"-I{src}", "-I/usr/include/jsoncpp",
           os.path.join(HERE, "pingplugin.cpp"),
           f"-L{src}", "-lfpp", f"-Wl,-rpath,{src}", "-o", os.path.join(d, f"lib{name}.so")]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("building the ping plugin failed:\n" + r.stderr[-4000:])
    return d


def test_a_one_shot_ping_is_sent_before_the_ping_thread_can_free_it(fppd):
    """A one-shot ping whose sender is held up between publishing the target
    and sending it is still sent from live memory: the ping thread can't
    time the target out and free it until the send is done.

    Regression: f0fce333d. ping() pushed the target onto the ping thread's
    list, released the lock and only then sent it. The ping thread could
    time the target out in that window (its deadline starts when it is
    made) and delete it, and the send read the freed packet: a
    heap-use-after-free under ASan on every startup of a single-core board,
    from mDNS discovery. slowrawsend.so widens the window to 600 ms, past
    the 50 ms timeout and the ping thread's 250 ms poll, so the old code
    loses the race every time. The red side needs a sanitizer build (the
    read of freed memory is otherwise silent).
    """
    install_ping_plugin(fppd)
    fppd.start(preload=[build("slowrawsend.c")])
    for _ in range(3):
        fppd.command("Ping Once", "127.0.0.1", "50", timeout=10)
        time.sleep(0.5)
    fppd.check_alive()
    assert fppd.get("/fppd/status").get("fppd") == "running"
