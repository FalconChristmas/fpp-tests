"""Sparse sequences with more ranges than the header can count.

A v2 header counts its sparse ranges in one byte (byte 22). xLights' sparse
saving makes a range per run of channels its models use, and a large show
goes past 255. FSEQ 2.3 keeps the first 255 in the header, counted as 255,
so earlier readers still play those, and puts the whole table in an 'SR'
variable header stored as extended data. Writers below 2.3 merge the
ranges across their smallest gaps until 255 are left, and the reader
recovers files from the earlier writers that stored the whole table but
only the low byte of its count.

Files are read back with test_fsequtils.read_fseq(), a reader written from
docs/FSEQ_Sequence_File_Format.txt, and played to a DDP receiver.
"""

import os
import time

import pytest

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq, write_fseq_reference
from show import install
from test_fsequtils import info, read_fseq
from test_playback import assert_faithful, start, wait_idle

STEP_MS = 50
FRAMES = 60
# 300 two-channel ranges with a two-channel gap after each.
RANGES = [(4 * i, 2) for i in range(300)]
SPACE = 4 * len(RANGES)


def frames():
    return unique_frames(FRAMES, SPACE)


def masked(source, ranges):
    """The frames as the wire shows them: only the ranges' channels lit."""
    keep = bytearray(SPACE)
    for s, n in ranges:
        keep[s:s + n] = b"\1" * n
    return [bytes(b if k else 0 for b, k in zip(f, keep)) for f in source]


def packed(source, ranges):
    """The frames as a sparse file stores them: the ranges back to back."""
    return [b"".join(f[s:s + n] for s, n in ranges) for f in source]


def play(fppd, source, expected, write):
    """Install a playlist for `source`, let `write` replace its sequence,
    play it, and check the wire against `expected`."""
    with DdpReceiver(SPACE) as rx:
        install(fppd, source, step_ms=STEP_MS)
        write(os.path.join(fppd.media, "sequences", "Show.fseq"))
        fppd.start()
        start(fppd)
        wait_idle(fppd, timeout=25)
        time.sleep(0.3)
        assert_faithful(expected, rx.snapshot())


@pytest.mark.parametrize("compression", [None, "zstd"])
def test_fpps_writer_stores_every_range(tmp_path, compression):
    """FPP's writer at 2.3, given 300 ranges, writes a 2.3 file with the
    first 255 in the header, counted as 255, and all 300 in 'SR'; each
    frame carries all 300. fsequtils -j, which /api/sequence/:name/meta
    serves, reports all 300 ranges and no 'SR' header.

    Regression: b4512194b. The header held all 300 ranges but counted
    300 & 0xFF = 44, so readers took 44 ranges and parsed the rest of the
    table as variable headers."""
    if compression == "zstd":
        pytest.importorskip("zstandard")
    src = frames()
    path = str(tmp_path / "many.fseq")
    write_fseq(path, src, step_ms=STEP_MS, compression=compression, sparse=RANGES, minor=3)
    hdr, got = read_fseq(path)
    assert hdr["minor"] == 3, hdr["minor"]
    assert hdr["header_ranges"] == RANGES[:255], f"{len(hdr['header_ranges'])} ranges in the header"
    assert hdr["ranges"] == RANGES, f"{len(hdr['ranges'])} ranges in 'SR'"
    assert hdr["channels"] == 2 * len(RANGES), hdr["channels"]
    assert got == packed(src, RANGES), "the frames do not carry every range"

    j = info(path)
    assert j["Version"] == "2.3", j["Version"]
    assert [(r["Start"], r["Length"]) for r in j.get("Ranges", [])] == RANGES, \
        f"fsequtils reports {len(j.get('Ranges', []))} ranges"
    assert "SR" not in j.get("variableHeaders", {}), j.get("variableHeaders")


def test_ranges_that_fit_the_header_are_marked_2_2(tmp_path):
    """FPP's writer at 2.3 with 255 ranges marks the file 2.2, as there is
    nothing 2.3 about it, and writes no 'SR'.

    Regression: b4512194b."""
    ranges = RANGES[:255]
    path = str(tmp_path / "fits.fseq")
    write_fseq(path, frames(), step_ms=STEP_MS, sparse=ranges, minor=3)
    hdr, _ = read_fseq(path)
    assert hdr["minor"] == 2, hdr["minor"]
    assert hdr["header_ranges"] == ranges and "SR" not in hdr["vheaders"], hdr["vheaders"].keys()


@pytest.mark.parametrize("minor", [0, 2])
def test_writer_below_2_3_merges_the_ranges_to_255(fppd, tmp_path, minor):
    """FPP's writer below 2.3, given 300 ranges, merges them across their
    smallest gaps into 255 that cover all 300, counted right, and the
    sequence plays every one of the 300.

    Regression: b4512194b (see test_fpps_writer_stores_every_range)."""
    src = frames()

    def write(p):
        write_fseq(p, src, step_ms=STEP_MS, sparse=RANGES, minor=minor)

    check = str(tmp_path / "merged.fseq")
    write(check)
    hdr, got = read_fseq(check)
    stored = hdr["ranges"]
    assert len(stored) == 255 and hdr["minor"] == minor, (len(stored), hdr["minor"])
    lost = [r for r in RANGES if not any(s <= r[0] and r[0] + r[1] <= s + n for s, n in stored)]
    assert not lost, f"{len(lost)} ranges not inside a stored one, first {lost[:3]}"
    assert got == packed(src, stored)
    play(fppd, src, masked(src, stored), write)


@pytest.mark.parametrize("writer", ["fpp", "reference"])
@pytest.mark.parametrize("compression", [None, "zstd"])
def test_more_than_255_ranges_play_every_range(fppd, writer, compression):
    """A 2.3 sequence with 300 ranges, from FPP's writer or an independent
    one, plays all 300 ranges' channels and nothing between them.

    Regression: b4512194b. Before 2.3 fppd took the 255 ranges in the
    header (or, from FPP's writer, 44) and the rest stayed dark."""
    if compression == "zstd":
        pytest.importorskip("zstandard")
    src = frames()

    def write(p):
        if writer == "fpp":
            write_fseq(p, src, step_ms=STEP_MS, compression=compression, sparse=RANGES, minor=3)
        else:
            write_fseq_reference(p, src, step_ms=STEP_MS, compression=compression, blocks=3,
                                 sparse=RANGES)

    play(fppd, src, masked(src, RANGES), write)


def test_truncated_range_count_from_earlier_writers_is_recovered(fppd):
    """A file from a writer before 2.3, with all 300 ranges in the header
    but counted as 300 & 0xFF = 44, plays all 300: the reader takes the
    count from the header length when its low byte matches and the ranges
    add up to the channel count.

    Regression: b4512194b."""
    src = frames()

    def write(p):
        write_fseq_reference(p, src, step_ms=STEP_MS, sparse=RANGES, range_count=len(RANGES))

    play(fppd, src, masked(src, RANGES), write)


def test_sr_that_does_not_extend_the_header_is_ignored(fppd, tmp_path):
    """A file holding 255 ranges with an 'SR' for 300, as an older writer
    leaves when it rewrites a 2.3 file and carries its variable headers
    across, plays the 255 in the header: 'SR' adds up to more channels
    than the file has, so the reader drops it.

    Coverage for b4512194b (an earlier reader ignores 'SR' anyway)."""
    src = frames()
    ranges = RANGES[:255]

    def write(p):
        write_fseq_reference(p, src, step_ms=STEP_MS, sparse=ranges, sr=RANGES)

    check = str(tmp_path / "stale.fseq")
    write(check)
    assert read_fseq(check)[0]["ranges"] == RANGES, "the file does not carry the stale 'SR'"
    j = info(check)
    assert len(j.get("Ranges", [])) == 255, f"fsequtils reports {len(j.get('Ranges', []))} ranges"
    play(fppd, src, masked(src, ranges), write)
