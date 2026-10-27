"""The warning a remote raises when it has to skip frames again and again at
the start of a sequence ("Multiple Frame Skips During Playback - Likely Slow
Network"), and how long it stays up."""

import os
import time

import shims
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, status
from test_command_socket import send
from test_multisync_remote_sequences import Master

SKIP_WARNING = "Multiple Frame Skips During Playback"


def skip_warning(fppd):
    return [w for w in fppd.get("/fppd/status").get("warnings", []) if SKIP_WARNING in w]


def test_the_slow_network_warning_ages_out(fppd):
    """A remote whose frames are read slower than they play (seq_readgap.so),
    following a master whose sync packets run ahead of it, skips forward on
    each packet in the sequence's first hundred frames and raises the slow
    network warning. Ten minutes on, with no more skips, the warning is gone.
    warnclock.so moves the clock fppd's warnings see -- and only that one --
    those ten minutes ahead, and a log level change makes the warnings
    thread look again.

    Regression: 3702e645d. The warning had no timeout and nothing removed
    it, so once raised it stayed up until fppd restarted."""
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), unique_frames(400, CHANNELS))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    clock = os.path.join(fppd.media, "tmp", "warnclock")
    log = clock + ".log"
    fppd.start(preload=[shims.build("seq_readgap.c", libs=()), shims.build("warnclock.c")],
               extra_env={"SEQ_READGAP_MS": "80", "WARNCLOCK_FILE": clock, "WARNCLOCK_LOG": log})
    master = Master()
    try:
        master.send("open")
        time.sleep(0.5)
        master.send("start")
        for frame in range(10, 100, 10):
            time.sleep(0.25)
            master.send("sync", frame)
        fppd.wait_for(lambda: skip_warning(fppd), timeout=5, what="the slow network warning")
        master.send("stop")
    finally:
        master.close()
    fppd.wait_for(lambda: not status(fppd).get("current_sequence"), timeout=10,
                  what="the sequence to stop")
    with open(clock + ".new", "w") as f:
        f.write("601\n")
    os.replace(clock + ".new", clock)
    send("LogLevel,General,debug")
    time.sleep(1)
    with open(log) as f:
        callers = f.read()
    assert not skip_warning(fppd), "the slow network warning is still up ten minutes on\n" + callers
