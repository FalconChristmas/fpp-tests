"""Stop commands sent while nothing is playing."""

import time

from fseq import solid_frames
from show import CHANNELS, install, status


def test_graceful_stop_while_idle_leaves_fppd_idle(fppd):
    """A graceful stop with nothing playing changes nothing: fppd stays idle,
    and a playlist started afterwards plays.

    Regression: the stop set "stopping gracefully" (or "after loop") on the
    idle playlist, and nothing cleared it. Fixed by e3c90bec8.
    """
    install(fppd, solid_frames(40, CHANNELS, 50))
    fppd.start()
    for args in (["false"], ["true"]):  # Stop Gracefully [afterCurrentLoop]
        fppd.command("Stop Gracefully", *args)
        time.sleep(1)
        assert status(fppd).get("status_name") == "idle", status(fppd)
    fppd.command("Start Playlist", "Show", "true", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10,
                  interval=0.5, what="a playlist started after the stop to play")
