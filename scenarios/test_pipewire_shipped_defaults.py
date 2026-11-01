"""etc/pipewire/pipewire.conf.d/90-fpp.conf as fpp ships it, loaded by a
PipeWire daemon of its own (no card, no WirePlumber): the graph clock the
daemon ends up with."""

import os
import re
import shutil
import subprocess
import tempfile
import time


def settings_of_daemon_with(conf):
    """pw-metadata's settings of a daemon started with `conf` as its
    pipewire.conf.d/90-fpp.conf."""
    tree = os.environ["FPP_TREE"]
    work = tempfile.mkdtemp(prefix="pipewire-defaults-")
    run = os.path.join(work, "run")
    os.makedirs(run)
    os.makedirs(os.path.join(work, "pw", "pipewire.conf.d"))
    for f in ("pipewire.conf", "client.conf"):
        shutil.copy(os.path.join("/usr/share/pipewire", f), os.path.join(work, "pw"))
    shutil.copy(os.path.join(tree, conf), os.path.join(work, "pw", "pipewire.conf.d", "90-fpp.conf"))
    env = dict(os.environ, PIPEWIRE_RUNTIME_DIR=run, XDG_RUNTIME_DIR=run, PIPEWIRE_CONFIG_DIR=os.path.join(work, "pw"))
    log = open(os.path.join(work, "pipewire.log"), "w")
    daemon = subprocess.Popen(["pipewire"], env=env, stdout=log, stderr=log, start_new_session=True)
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            r = subprocess.run(["pw-metadata", "-n", "settings"], env=env, capture_output=True, text=True, timeout=10)
            if "clock.quantum" in r.stdout:
                return {k: v for k, v in re.findall(r"key:'([^']*)' value:'([^']*)'", r.stdout)}
            time.sleep(0.25)
        raise AssertionError("the daemon never published its settings:\n" + r.stdout + r.stderr + open(log.name).read()[-1500:])
    finally:
        daemon.terminate()
        daemon.wait(10)
        shutil.rmtree(work, ignore_errors=True)


def test_the_shipped_defaults_run_the_graph_at_a_1024_frame_quantum():
    """A daemon loading the shipped 90-fpp.conf runs with a 1024-frame
    quantum (about 21 ms at 48 kHz), allowed to move between 256 and 2048:
    the min and max differ from the daemon's own defaults (32 and 2048), so
    the file is read as well as parsed.

    Feature: c31d48aaa. The defaults were 256 (5.3 ms), 128 and 512: a
    quantum small enough that a Pi under load missed its deadline and the
    graph dropped out, the latency-for-stability trade the player is
    tuned for."""
    s = settings_of_daemon_with("etc/pipewire/pipewire.conf.d/90-fpp.conf")
    assert s["clock.quantum"] == "1024", s
    assert s["clock.min-quantum"] == "256", s
    assert s["clock.max-quantum"] == "2048", s
    assert s["clock.rate"] == "48000", s
