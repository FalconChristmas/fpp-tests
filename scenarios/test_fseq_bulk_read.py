"""Reading a whole zstd sequence front to back: FSEQFile's block-parallel
("bulk") reader.

fsequtils asks for ReadPattern::Bulk on every file it reads in full
(converting, merging, dumping). For a zstd v2 file with more than one
compression block, V2ZSTDCompressionHandler then decompresses blocks ahead
of the reader on a pool of worker threads (bulkConfigure, bulkWorker,
bulkDispatch, bulkGetBlock), holding them in a ring of one slot per worker
plus one. fppd's playback never takes this path: it streams one frame at a
time. So these scenarios drive it through fsequtils, on sequences with many
more blocks than slots, so every slot is reused several times, and check
every frame that comes out against the frames that went in, read back with
test_fsequtils.read_fseq() (a reader independent of FPP's).

Under TSan the worker pool is what is being checked for races; the tool
carries the tree's sanitizer, and test_fsequtils.fsequtils() fails on any
report.

Not reachable from any caller, so not covered here: bulkDrain (only a
backwards or far-forward jump restarts the window; fsequtils always reads
in order), the "declined: exceeds the budget" branch (it needs two blocks of
over 128 MB each), and FSEQFile::getMediaFilename (nothing in fpp calls it).
"""

import os
import struct

import pytest

from fseq import unique_frames, write_fseq, write_fseq_reference
from test_fsequtils import fsequtils, info, read_fseq

zstandard = pytest.importorskip("zstandard")

# 2048 channels x 3001 frames is ~6 MB, which FPP's writer cuts into 64 KB
# blocks: about 90 of them, against a ring of (cores + 1) slots.
CHANNELS = 2048
FRAMES = 3001
STEP_MS = 25


def ring_slots():
    """Slots in the bulk reader's ring: a worker per core (std::thread::
    hardware_concurrency, which the budget does not cut at these block
    sizes), plus one."""
    return (os.cpu_count() or 1) + 1


def assert_ring_wraps(path):
    """Skip, rather than fail, where the host's core count defeats the
    scenario: with one core the bulk reader is never used, and with very many
    the ring has more slots than these files have blocks."""
    if (os.cpu_count() or 1) <= 1:
        pytest.skip("one core: FSEQFile never uses the bulk reader")
    n = len(blocks(path))
    if n <= 2 * ring_slots():
        pytest.skip(f"only {n} blocks for {ring_slots()} slots on this host: the ring would not wrap")


def blocks(path):
    """The block table of a compressed v2 file: [(first_frame, offset,
    length)], offsets absolute in the file."""
    with open(path, "rb") as f:
        data = f.read(65536)
    data_offset = struct.unpack_from("<H", data, 4)[0]
    nblocks = ((data[20] >> 4) << 8) | data[21]
    out, off = [], data_offset
    for i in range(nblocks):
        first, length = struct.unpack_from("<II", data, 32 + 8 * i)
        if length:
            out.append((first, off, length))
        off += length
    return out


def unique_id(path):
    with open(path, "rb") as f:
        return f.read(32)[24:32]


def first_difference(got, want):
    bad = [i for i in range(max(len(got), len(want)))
           if i >= len(got) or i >= len(want) or got[i] != want[i]]
    if not bad:
        return None
    i = bad[0]
    g = list(got[i][:12]) if i < len(got) else None
    w = list(want[i][:12]) if i < len(want) else None
    return f"{len(bad)} frames differ, first {i}: got {g}..., want {w}..."


@pytest.fixture(scope="module")
def frames():
    return unique_frames(FRAMES, CHANNELS)


@pytest.fixture
def zsrc(tmp_path, frames):
    """The frames as a zstd v2 file written by FPP, with a media file name.
    The scenarios rely on it holding many more blocks than the reader's ring
    has slots (one per core, plus one)."""
    path = str(tmp_path / "src.fseq")
    write_fseq(path, frames, step_ms=STEP_MS, compression="zstd", media="song.mp3")
    assert_ring_wraps(path)
    return path


def test_multi_block_zstd_converts_exactly(zsrc, frames, tmp_path):
    """A many-block zstd sequence written out again as v2 uncompressed, zlib,
    zstd and v2.1 zstd, and as v1, keeps every channel of every frame. The new
    file also keeps the step time, the media file name ('mf' header) and, for
    v2, the original's unique id: fsequtils copies all three from the source
    (initializeFromFSEQ) instead of the writer making up a new id."""
    for fmt, comp, major, minor, ctype in (("2", "none", 2, 0, 0), ("2", "zlib", 2, 0, 2),
                                           ("2", "zstd", 2, 0, 1), ("2.1", "zstd", 2, 1, 1),
                                           ("1", "none", 1, 0, 0)):
        what = f"-f {fmt} -c {comp}"
        out = str(tmp_path / f"out-{fmt}-{comp}.fseq")
        rc, stdout, err = fsequtils("-f", fmt, "-c", comp, "-o", out, zsrc)
        assert rc == 0, (what, stdout + err)
        hdr, got = read_fseq(out)
        assert (hdr["major"], hdr["minor"], hdr["compression"]) == (major, minor, ctype), (what, hdr)
        assert hdr["step"] == STEP_MS and hdr["channels"] == CHANNELS, (what, hdr)
        assert hdr["frames"] == FRAMES, (what, hdr)
        diff = first_difference(got, frames)
        assert diff is None, f"{what}: {diff}"
        if major == 2:
            assert info(out).get("variableHeaders", {}).get("mf") == "song.mp3", what
            assert unique_id(out) == unique_id(zsrc), what


def test_ranges_of_a_multi_block_zstd_file(zsrc, frames, tmp_path):
    """-r picks channels out of each decompressed frame: as a sparse file
    holding just those ranges, and with -n as a full file with them in place.

    Only the range is checked in the -n file: fsequtils writes the channels
    outside it from a buffer it never clears (~/PROBLEMS.md #15)."""
    out = str(tmp_path / "sparse.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-r", "11-20", "-r", "2001+48", "-o", out, zsrc)
    assert rc == 0, stdout + err
    hdr, got = read_fseq(out)
    assert hdr["ranges"] == [(10, 10), (2000, 48)] and hdr["channels"] == 58, hdr
    diff = first_difference(got, [f[10:20] + f[2000:2048] for f in frames])
    assert diff is None, diff

    out = str(tmp_path / "full.fseq")
    rc, stdout, err = fsequtils("-n", "-c", "zstd", "-r", "101-200", "-o", out, zsrc)
    assert rc == 0, stdout + err
    hdr, got = read_fseq(out)
    assert hdr["ranges"] == [] and hdr["channels"] == CHANNELS, hdr
    diff = first_difference([g[100:200] for g in got], [f[100:200] for f in frames])
    assert diff is None, diff


def test_sparse_multi_block_zstd_file_converts_exactly(frames, tmp_path):
    """A sparse zstd file (only some channel ranges stored), many blocks
    long, written out dense: each stored range lands back at its own channels,
    and the file's channel count is the end of the last range."""
    ranges = [(0, 700), (900, 600), (1700, 348)]
    src = str(tmp_path / "sparse.fseq")
    write_fseq(src, frames, step_ms=STEP_MS, compression="zstd", sparse=ranges)
    assert_ring_wraps(src)
    out = str(tmp_path / "dense.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-o", out, src)
    assert rc == 0, stdout + err
    hdr, got = read_fseq(out)
    assert hdr["ranges"] == [] and hdr["channels"] == CHANNELS, hdr
    assert len(got) == FRAMES, hdr
    # Only the stored ranges: fsequtils writes the channels between them from
    # a buffer it never clears (~/PROBLEMS.md #15).
    for s, n in ranges:
        diff = first_difference([g[s:s + n] for g in got], [f[s:s + n] for f in frames])
        assert diff is None, f"range {s}+{n}: {diff}"


def test_merging_two_multi_block_zstd_files(frames, tmp_path):
    """-m over a zstd base with a zstd overlay: two bulk readers at once,
    each with its own worker pool. The result is the base wherever the
    overlay is dark and the overlay elsewhere, in every frame.

    Both are the same length: an overlay shorter than the base crashes
    fsequtils (~/PROBLEMS.md #14)."""
    base = str(tmp_path / "base.fseq")
    write_fseq(base, frames, step_ms=STEP_MS, compression="zstd")
    lit = range(200, 1224)
    over_frames = [bytes(200) + bytes([(i * 7 + c) % 255 + 1 for c in range(1024)]) + bytes(CHANNELS - 1224)
                   for i in range(FRAMES)]
    over = str(tmp_path / "over.fseq")
    write_fseq(over, over_frames, step_ms=STEP_MS, compression="zstd")
    assert_ring_wraps(over)
    out = str(tmp_path / "m.fseq")
    # -r limits the merge to the overlay's lit channels: without it fsequtils
    # walks all 8M channels of every frame, which takes minutes under TSan.
    rc, stdout, err = fsequtils("-c", "none", "-o", out, "-m", over, "-r", "201-1224", base)
    assert rc == 0, stdout + err
    _, got = read_fseq(out)
    want = [f[:lit.start] + o[lit.start:lit.stop] + f[lit.stop:] for f, o in zip(frames, over_frames)]
    diff = first_difference(got, want)
    assert diff is None, diff


def test_dump_walks_every_block(zsrc, frames):
    """-d -r dumps the range of every frame: the first and last frame of each
    block (where a reader moves from one slot of the ring to the next) show
    their own channels."""
    rc, out, err = fsequtils("-d", "-r", "1-8", zsrc, timeout=300)
    assert rc == 0, (out + err)[-3000:]
    lines = (out + err).splitlines()
    dumped = {}
    for i, line in enumerate(lines):
        if "Frame: " in line and ", Range: 0-7" in line:
            n = int(line.split("Frame: ")[1].split(",")[0])
            dumped[n] = lines[i + 1].lower() if i + 1 < len(lines) else ""
    assert sorted(dumped) == list(range(FRAMES)), f"dumped {len(dumped)} frames"
    table = blocks(zsrc)
    edges = {0, FRAMES - 1}
    for k, (first, _, _) in enumerate(table):
        edges.add(first)
        if first:
            edges.add(first - 1)
    for n in sorted(edges):
        want = " ".join(f"{b:02x}" for b in frames[n][:8])
        assert want in dumped[n], (n, dumped[n], want)


def test_corrupt_block_comes_out_dark_not_stale(zsrc, frames, tmp_path):
    """A block whose zstd data is garbage is logged and comes out as dark
    frames; every other block is exact. The garbage block is far enough in
    that its ring slot last held another block, so leftover frames of that
    block would show here if the slot were not cleared."""
    table = blocks(zsrc)
    k = len(table) - 4
    assert k >= ring_slots(), "the corrupt block's slot must have held a block before"  # assert_ring_wraps ensures it
    first, off, length = table[k]
    end = table[k + 1][0]
    with open(zsrc, "r+b") as f:
        f.seek(off)
        f.write(b"\xde\xad\xbe\xef" * 4)
    out = str(tmp_path / "out.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-o", out, zsrc)
    assert rc == 0, stdout + err
    _, got = read_fseq(out)
    want = list(frames)
    want[first:end] = [bytes(CHANNELS)] * (end - first)
    diff = first_difference(got, want)
    assert diff is None, f"block {k} (frames {first}-{end - 1}) garbled: {diff}"


def test_blocks_of_several_zstd_streams(frames, tmp_path):
    """A file whose every block is three zstd streams back to back (which
    the format allows, though FPP's own writer makes one): the reader goes
    on from one stream to the next until the block's frames are all out,
    frames split across two streams included."""
    src = str(tmp_path / "streams.fseq")
    write_fseq_reference(src, frames, step_ms=STEP_MS, compression="zstd", blocks=100, streams=3)
    assert_ring_wraps(src)
    out = str(tmp_path / "out.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-o", out, src)
    assert rc == 0, stdout + err
    _, got = read_fseq(out)
    diff = first_difference(got, frames)
    assert diff is None, diff


def test_converting_a_multi_block_zstd_file_uses_the_bulk_reader(zsrc, frames, tmp_path):
    """The conversions above are checked frame for frame, but a streaming
    read gets the same frames: this one checks that fsequtils actually took
    the block-parallel path -- its verbose log names the worker pool -- and
    still wrote every frame.

    Regression: 13681489d, which added the bulk reader and had fsequtils
    ask for it (setReadPattern(Bulk)) on the files it reads in full."""
    out = str(tmp_path / "out.fseq")
    rc, stdout, err = fsequtils("-v", "-c", "none", "-o", out, zsrc)
    assert rc == 0, stdout + err
    assert "Bulk read:" in stdout + err, "fsequtils read the file without the bulk reader"
    _, got = read_fseq(out)
    diff = first_difference(got, frames)
    assert diff is None, diff
