"""A show that keeps running into the same problem must not write the log
every frame. Devices log to an SD card or eMMC: a line per frame is
20-100 lines a second for the length of the show, which wears the card and
buries everything else in the log. Each problem is logged once (or now and
then) and, where a user can act on it, shown as a warning.
"""

import time

import pytest

from fseq import unique_frames
from show import CHANNELS, install

# Nothing answers here, and in the test's network namespace there is no
# route to it at all, so every send to it fails.
NOWHERE = "10.77.0.9"


def log_growth(fppd, seconds=5):
    start = len(fppd.log())
    time.sleep(seconds)
    return len(fppd.log()) - start


def play(fppd):
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                  what="the show to play")
    time.sleep(1)  # past whatever is logged once as it starts


def test_unreachable_multisync_remote(fppd):
    """A master with a unicast remote that is not there fails to send it
    every sync packet; that is logged when it starts and then once a minute,
    not for each packet (about two lines a second, 1.4 MB of log an hour).
    Regression: fixed by a00caa85d."""
    install(fppd, unique_frames(1200, CHANNELS))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=NOWHERE)
    fppd.start()
    play(fppd)
    start = fppd.log().count("Unable to send multisync packet")
    time.sleep(5)
    lines = fppd.log().count("Unable to send multisync packet") - start
    assert lines == 0, f"{lines} lines about the unreachable MultiSync remote in 5 s"


@pytest.mark.parametrize("kind", ["E1.31", "DDP"])
def test_unreachable_controller(fppd, kind):
    """An output to a controller that is not there (and not pinged) fails
    every send; that is logged now and then, not each frame."""
    install(fppd, unique_frames(1200, CHANNELS))
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": CHANNELS,
        "universes": [{"active": 1, "description": "gone", "id": 1, "startChannel": 1,
                       "channelCount": CHANNELS, "type": 1 if kind == "E1.31" else 5,
                       "address": NOWHERE, "priority": 0, "monitor": 0, "deDuplicate": 0}],
    }]})
    fppd.start()
    play(fppd)
    grew = log_growth(fppd)
    assert grew < 2000, f"fppd.log grew {grew} bytes in 5 s with the {kind} controller unreachable"
