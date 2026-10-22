"""What MultiSync's discovery and configured-output bookkeeping cost fppd's
startup: a scan of devices that never finish answering, an output hostname
that no longer resolves, and how often co-universes.json is re-read for the
ranges map.
"""

import collections
import os
import re
import shutil
import subprocess
import sys
import time

import shims
from fake_devices import device_network


def main_loop_after(fppd):
    """Seconds from fppd's start to "Starting main processing loop"."""
    fppd.wait_for(lambda: "Starting main processing loop" in fppd.log(), timeout=60,
                  interval=0.2, what="fppd to reach its main loop")
    return time.monotonic() - fppd.started


def test_a_scan_of_devices_that_never_answer_does_not_hold_startup(fppd):
    """An HTTP discovery scan (MultiSyncHTTPSubnets) of eight FPP-looking
    devices that serve their front page and then never answer the
    detector's /api/system/info: fppd reaches its main loop as quickly as
    without them, and its API answers meanwhile.

    Regression: ecc7fa3df. Discover() ran the scan inline on the main loop
    at startup, with each answering device's detector making blocking curl
    calls one after another: 30 s each here, so fppd sat four minutes short
    of its main loop, outputs and schedule not running.
    """
    addresses = [f"10.88.0.{i}" for i in range(10, 18)]
    server = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hanging_device_server.py")
    with device_network(addresses) as run:
        p = run(sys.executable, "-I", server, ",".join(addresses))
        assert p.stdout.readline().strip() == "ready", "the hanging device server did not start"
        fppd.settings(MultiSyncHTTPSubnets=",".join(addresses))
        fppd.start()
        took = main_loop_after(fppd)
        assert took < 20, f"fppd reached its main loop {took:.0f} s after starting"
        assert fppd.get("/fppd/status", timeout=5)["status_name"]


GONE = "fpp-test-output.invalid"


def universes_to(address, n=2):
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510 * n,
        "universes": [{"active": 1, "description": "", "id": i + 1, "startChannel": 510 * i + 1,
                       "size": 510, "type": 1, "address": address, "priority": 0,
                       "monitor": 0, "deDuplicate": 0, "channelCount": 510}
                      for i in range(n)]}]}


def test_an_output_hostname_is_looked_up_once_at_startup(fppd):
    """Two E1.31 universes sent to a hostname that doesn't resolve: fppd
    looks the name up once while it starts, however many places need it --
    a failed lookup is remembered too. (countgai.c fails the lookup at once
    and records who asked; a real resolver takes seconds to fail one.) Not
    counted: libcurl resolving the name itself, on its own resolver thread,
    for HTTP discovery's probe of the configured address.

    Regression: dff716566. Nothing remembered a lookup: MultiSync's range
    map, its sync destinations and each UDP output resolved the name again,
    all on the main thread, and a dead name cost a resolver timeout every
    time -- 23 s of a 26 s start on a player with two such hostnames.
    """
    log = os.path.join(fppd.media, "tmp", "countgai.log")
    fppd.write("config/co-universes.json", universes_to(GONE))
    fppd.start(preload=[shims.build("countgai.c")],
               extra_env={"COUNTGAI_NAME": GONE, "COUNTGAI_FILE": log})
    main_loop_after(fppd)
    time.sleep(3)
    lookups = readers(log, first_field=True)
    mine = [s for s in lookups if "libcurl" not in s]
    assert mine, "fppd never looked the name up, so this proves nothing:\n" + "\n\n".join(lookups)
    assert len(mine) == 1, f"{len(mine)} lookups of one name:\n" + "\n\n".join(mine)


def readers(trace_file, first_field=False):
    """For each call a shim recorded (readtrace.c, countgai.c), the names of
    the functions on its call stack (addr2line, so inlined and file-local
    functions count too). first_field: each line starts with a thread name."""
    if not os.path.exists(trace_file):
        return []
    with open(trace_file) as f:
        lines = [line.split() for line in f if line.strip()]
    heads = [line.pop(0) if first_field else "" for line in lines]
    stacks = [[fr.split("@") for fr in line] for line in lines]
    names = {}
    if shutil.which("addr2line"):
        by_obj = collections.defaultdict(set)
        for stack in stacks:
            for obj, off, _ in stack:
                by_obj[obj].add(off)
        for obj, offs in by_obj.items():
            offs = sorted(offs)
            out = subprocess.run(["addr2line", "-a", "-f", "-i", "-C", "-e", obj, *("0x" + o for o in offs)],
                                 capture_output=True, text=True).stdout.splitlines()
            cur, k = None, 0
            for line in out:
                if re.fullmatch(r"0x[0-9a-f]+", line):
                    cur, k = (obj, "%x" % int(line, 16)), 0
                    names[cur] = []
                elif cur is not None:
                    if k % 2 == 0:  # function, then file:line, per (inlined) frame
                        names[cur].append(line)
                    k += 1
    result = []
    for head, stack in zip(heads, stacks):
        funcs = [head] if head else []
        for obj, off, sym in stack:
            funcs.append(sym if sym != "-" else os.path.basename(obj))
            funcs.extend(names.get((obj, off), []))
        result.append(" | ".join(funcs))
    return result


def test_the_output_ranges_map_is_built_once_at_startup(fppd):
    """MultiSync's map of configured output ranges (the channel ranges it
    lists for non-FPP remotes) is built from co-universes.json once while
    fppd starts, not again when the channel outputs start watching the same
    file. readtrace.c records the call stack of every read of the file.

    Regression: 6611378ae. Each watcher "primed" itself by firing every
    callback on the file, so the channel outputs' registration re-ran
    MultiSync's reload: a second read of the file and, before dff716566
    cached lookups, a second blocking lookup of every output hostname in it.

    The map is 53185d08f's cache, built when the file is watched: without it
    there is no startup build at all (the list rebuilt it on every request,
    which this does not check).
    """
    trace = os.path.join(fppd.media, "tmp", "readtrace.log")
    fppd.write("config/co-universes.json", universes_to("10.20.30.90"))
    fppd.start(preload=[shims.build("readtrace.c")],
               extra_env={"READTRACE_SUFFIX": "/co-universes.json", "READTRACE_FILE": trace})
    main_loop_after(fppd)
    time.sleep(1)
    reads = readers(trace)
    multisync = [r for r in reads if "ReloadConfiguredOutputRanges" in r]
    outputs = [r for r in reads if "ReloadChannelOutputsForFile" in r or "InitializeChannelOutputs" in r]
    assert outputs, "the channel outputs' read wasn't seen, so the trace proves nothing:\n" + "\n".join(reads)
    assert len(multisync) == 1, f"{len(multisync)} builds of the ranges map:\n" + "\n\n".join(multisync)
