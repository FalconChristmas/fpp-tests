"""The eFuse warning names the sequence that was playing when the fuse
tripped (OutputMonitor::addEFuseWarning). The port is PixelCountSim's, as in
test_efuse_ports.py, whose helpers this uses."""

import os
import re
import time

from fseq import solid_frames, write_fseq
from show import playlist, sequence_entry
from test_efuse_ports import efuse_warnings, powered_port, trip


def install_sequence(fppd):
    write_fseq(os.path.join(fppd.media, "sequences", "Tripper.fseq"), solid_frames(2400, 150, 7), step_ms=50)
    fppd.write("playlists/Tripper.json", playlist("Tripper", [sequence_entry("Tripper.fseq")]))


def test_an_efuse_warning_carries_the_running_sequence_and_its_time(fppd):
    """A port's fuse trips while a sequence plays: the warning reads
    "eFUSE Triggered for Port 1 (<sequence>.fseq/<m>:<s>)".

    Regression: e02bc9f49 (added the sequence file name and the time into it
    to the eFuse warnings, so a person can find which part of a show tripped
    the fuse)."""
    install_sequence(fppd)
    powered_port(fppd, eFuseRetryCount="0")
    fppd.command("Start Playlist", "Tripper", "false", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing", timeout=10, what="the sequence to play")
    time.sleep(1.5)
    trip()
    fppd.wait_for(lambda: efuse_warnings(fppd), timeout=10, what="the eFuse warning")
    warnings = efuse_warnings(fppd)
    assert len(warnings) == 1 and re.fullmatch(r"eFUSE Triggered for Port 1 \(Tripper\.fseq/\d+:\d+\)", warnings[0]), warnings


def test_an_efuse_warning_with_nothing_playing_has_no_sequence(fppd):
    """The control for the one above: a trip with no sequence running is the
    bare "eFUSE Triggered for Port 1"."""
    install_sequence(fppd)
    powered_port(fppd, eFuseRetryCount="0")
    trip()
    fppd.wait_for(lambda: efuse_warnings(fppd), timeout=10, what="the eFuse warning")
    assert efuse_warnings(fppd) == ["eFUSE Triggered for Port 1"], efuse_warnings(fppd)
