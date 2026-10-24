"""The output ranges: which channels the outputs need, recomputed on every
output reload and read by the output thread's blanking, the sequence open,
MultiSync's system list and the channel tester while it is.
"""

import threading
import time

from ddp import DdpReceiver
from fseq import unique_frames
from show import CHANNELS, ddp_output, install


def test_outputs_reloaded_while_their_ranges_are_read(fppd):
    """Saving the outputs five times, with a different channel count each
    time, while a sequence plays, a client polls /fppd/multiSyncSystems and
    test mode is started on each save: fppd answers throughout and the
    sequence keeps reaching the wire, and (under TSan) nothing races.

    Regression: cfaec4a0a (verify with --flavor tsan). ComputeOutputRanges()
    swapped the two range lists with no lock while other threads iterated
    the live lists GetOutputRanges() handed out, so a reload could free a
    list mid-loop.
    """
    install(fppd, unique_frames(2000, CHANNELS))
    stop = threading.Event()
    errors = []

    def poll():
        while not stop.is_set():
            try:
                fppd.get("/fppd/multiSyncSystems")
            except Exception as e:  # a wedge or a crash; reported below
                errors.append(e)
                return
            time.sleep(0.02)

    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Show", "true", "false")
        assert rx.wait_frames(10, timeout=10), "the sequence never reached the wire"
        poller = threading.Thread(target=poll, daemon=True)
        poller.start()
        try:
            for i in range(5):
                time.sleep(1.1)  # a save in a later second, as a person makes it
                fppd.write("config/co-universes.json", ddp_output(CHANNELS - 10 * (i % 2)))
                time.sleep(0.3)
                fppd.command("Test Start", "100", "RGB Cycle", "1-30", "R-G-B")
                fppd.command("Test Stop")
        finally:
            stop.set()
            poller.join()
        assert not errors, f"/fppd/multiSyncSystems failed: {errors[0]}"
        loads = fppd.log().count("Calling Init() on UDPOutput output")
        assert loads >= 6, f"the outputs loaded {loads} times for 5 saves"
        assert rx.wait_frames(10, timeout=5, since=time.monotonic()), \
            "the sequence stopped reaching the wire"
