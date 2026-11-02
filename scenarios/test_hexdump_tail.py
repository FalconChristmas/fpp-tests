"""HexDump(), the debug dump of channel data in the log: the ASCII column of
a last, short line."""

import os

from fseq import write_fseq
from show import playlist, sequence_entry

CHANNELS = 21  # one full 16-byte line, then a 5-byte one


def test_hexdump_short_last_line_hides_log_escapes(fppd):
    """The ASCII column of a dump's short last line shows '%' and '\\' as '.'
    (they are escapes for the Log call) and everything else as it is.

    Regression: 8971c2688. The tail tested str[16 - x] (a byte of the line
    before, or of nothing) instead of the byte being printed, so escapes in
    the tail went to the log unchanged -- on its parent, a crash when the
    log call took them as a format."""
    tail = b"x%\\yz"
    frame = b"A" * 16 + tail
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), [frame] * 100, step_ms=50)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "Debug", "enabled": 1, "startChannel": 1, "channelCount": CHANNELS,
        "description": "dump"}]})
    fppd.settings(LogLevel_ChannelOut="debug", DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: "000010: 78 25 5c 79 7a" in fppd.log(), timeout=10,
                  what="the dump's short last line in the log")
    line = next(l for l in fppd.log().splitlines() if "000010: 78 25 5c 79 7a" in l)
    assert line.endswith("x..yz"), line
    assert "Crash handler called" not in fppd.log(), fppd.tail()
