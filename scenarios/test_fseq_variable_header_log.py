"""What fppd logs while reading a sequence file's variable headers.

The headers (media file 'mf', writer 'sp') are checked as the file is opened:
a string header that is not NUL terminated, or one whose length runs past the
header, is logged as an error."""

import os
import re
import struct

from fseq import unique_frames, write_fseq_reference
from show import CHANNELS, ddp_output, playlist, sequence_entry


def play(fppd, seq):
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry(seq)]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("Start Playlist", "Show", "true", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("current_sequence") == seq,
                  timeout=15, what="the sequence playing")


def header_errors(fppd):
    return [line for line in fppd.log().splitlines() if "VariableHeader" in line]


def test_a_well_formed_header_is_not_reported_as_bad(fppd):
    """A media file name and a writer string, both NUL terminated and each
    followed by more header, read without any complaint.

    Regression: 9e40515dc. The length of a header still counted its own four
    bytes of length and code when the NUL check looked at its last byte, so
    the check read past the end of the string and logged "not NULL
    terminated" for a header that was fine."""
    path = os.path.join(fppd.media, "sequences", "Show.fseq")
    write_fseq_reference(path, unique_frames(40, CHANNELS), media="song.mp3")
    play(fppd, "Show.fseq")
    assert header_errors(fppd) == [], header_errors(fppd)


def test_a_header_running_past_the_end_reports_where_it_ends(fppd):
    """A header whose length claims more than the file's header holds is
    logged with the header's code and the offset its data would end at.

    Regression: 9e40515dc. The offset had the two code bytes counted twice
    and the code was read back from the buffer after the index moved on, so
    the message named the wrong header and a wrong size."""
    path = os.path.join(fppd.media, "sequences", "Show.fseq")
    write_fseq_reference(path, unique_frames(40, CHANNELS), media="song.mp3")
    data = bytearray(open(path, "rb").read())
    data_offset = struct.unpack_from("<H", data, 4)[0]
    at = data.index(b"sp", 32)  # code of the writer header; its length is the two bytes before
    struct.pack_into("<H", data, at - 2, 2000)
    open(path, "wb").write(bytes(data))
    play(fppd, "Show.fseq")
    errs = header_errors(fppd)
    assert len(errs) == 1, errs
    m = re.search(r"VariableHeader 'sp' has out of bounds data length: (\d+) bytes, max length: (\d+) bytes", errs[0])
    assert m, errs[0]
    # Index of the data (after the 4 bytes of length and code) plus the length.
    assert int(m.group(1)) == (at + 2) + 2000, (m.groups(), at)
    assert int(m.group(2)) == data_offset, (m.groups(), data_offset)
