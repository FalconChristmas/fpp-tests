"""A sequence opened while the one before it is still starting -- opened,
not yet playing -- and its frames are still being read in."""

import os
import socket
import time

import shims
from fseq import unique_frames, write_fseq
from multisync import PORT, sync_packet
from show import CHANNELS, ddp_output, status


def test_an_open_while_the_previous_sequence_is_mid_read(fppd):
    """A remote is told to open A, and then, while its reader thread is
    still inside A's first frame read (life_readhold.so holds it between
    the seek and the read for 1.5 s), to open B. B opens and plays, and
    nothing touches A's file after it is gone.

    Regression: 875614745 (the "zoom room" crash). Replacing a sequence that
    was still starting skipped CloseSequenceFile(), and the open deleted the
    old FSEQFile holding only the frame cache lock, while the reader held
    only the read lock in the middle of getFrame() on it: a use after free,
    which corrupted the heap. ASan reports it at the read that follows the
    seek."""
    write_fseq(os.path.join(fppd.media, "sequences", "A.fseq"), unique_frames(400, CHANNELS))
    write_fseq(os.path.join(fppd.media, "sequences", "B.fseq"), unique_frames(400, CHANNELS, first=1000))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    hold = os.path.join(fppd.media, "tmp", "readhold")
    open(hold, "w").close()
    fppd.start(preload=[shims.build("life_readhold.c")],
               extra_env={"LIFE_READHOLD_FILE": hold, "LIFE_READHOLD_MS": "1500"})
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        def send(action, name, frame=0):
            sock.sendto(sync_packet(action, "fseq", frame, frame * 0.05, name), ("127.0.0.1", PORT))

        send("open", "A.fseq")
        fppd.wait_for(lambda: os.path.exists(hold + ".held"), timeout=10,
                      what="the reader to be inside A's first frame")
        send("open", "B.fseq")
        time.sleep(2.5)  # past the hold: the reader finishes A's frame
        fppd.check_alive()
        reports = fppd.sanitizer_reports()
        assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
        send("start", "B.fseq")
        for frame in range(0, 40, 10):
            time.sleep(0.5)
            send("sync", "B.fseq", frame)
        fppd.wait_for(lambda: status(fppd).get("current_sequence") == "B.fseq", timeout=5,
                      what="B to play")
        send("stop", "B.fseq")
    finally:
        sock.close()
