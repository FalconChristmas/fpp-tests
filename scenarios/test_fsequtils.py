"""fsequtils, the FSEQ command-line tool: metadata as JSON, a hex dump of a
channel range, conversion between versions and compressions, sparse range
extraction, and merging one sequence onto another.

Its output files are checked with read_fseq() below, a reader written from
docs/FSEQ_Sequence_File_Format.txt rather than FPP's own, so a file the tool
writes wrong cannot be read back "right" by the same mistake. The tool runs
with the tree's sanitizer, so a memory error or a leak fails it too.
"""

import json
import os
import struct
import subprocess
import zlib

import pytest

from fseq import unique_frames, write_fseq

try:
    import zstandard
except ImportError:
    zstandard = None

CHANNELS = 64
FRAMES = 20


def fsequtils(*args, timeout=60):
    """Run the tree's fsequtils; return (returncode, stdout, stderr). A
    sanitizer report fails the scenario whatever the exit code."""
    tool = os.path.join(os.environ["FPP_TREE"], "src", "fsequtils")
    if not os.path.exists(tool):
        pytest.skip("no fsequtils in the tree under test")
    r = subprocess.run([tool, *map(str, args)], capture_output=True, text=True, timeout=timeout)
    assert "Sanitizer" not in r.stderr, r.stderr[-8000:]
    return r.returncode, r.stdout, r.stderr


def info(path):
    rc, out, err = fsequtils("-j", path)
    assert rc == 0, out + err
    return json.loads(out)


def _decompress(ctype, blob):
    """One compression block, which may hold several concatenated streams."""
    out = b""
    while blob:
        if ctype == 1:
            d = zstandard.ZstdDecompressor().decompressobj()
            out += d.decompress(blob)
            blob = d.unused_data
        else:
            d = zlib.decompressobj()
            out += d.decompress(blob)
            blob = d.unused_data
    return out


def read_fseq(path):
    """(header, frames) of a v1 or v2 FSEQ file. Frames are the stored
    channels only: for a sparse file, its ranges back to back.

    header["ranges"] is the whole sparse range table: from 2.3, an 'SR'
    variable header holds it when it is longer than the 255 the header can
    count, and header["header_ranges"] is then the header's own table."""
    with open(path, "rb") as f:
        data = f.read()
    assert data[:4] == b"PSEQ", f"{path} is not an FSEQ file: {data[:4]!r}"
    data_offset, minor, major, header_len, channels, count, step = struct.unpack_from(
        "<HBBHIIB", data, 4)
    hdr = {"major": major, "minor": minor, "channels": channels, "frames": count,
           "step": step, "ranges": [], "compression": 0}
    if major == 1:
        body = data[data_offset:]
        return hdr, [body[i * channels:(i + 1) * channels] for i in range(count)]
    ctype_byte, nblocks_lo, nranges = struct.unpack_from("<BBB", data, 20)
    ctype = ctype_byte & 0x0F
    nblocks = ((ctype_byte >> 4) << 8) | nblocks_lo
    hdr["compression"] = ctype
    pos = 32
    blocks = []
    for _ in range(nblocks):
        first, length = struct.unpack_from("<II", data, pos)
        blocks.append((first, length))
        pos += 8
    for _ in range(nranges):
        start = int.from_bytes(data[pos:pos + 3], "little")
        n = int.from_bytes(data[pos + 3:pos + 6], "little")
        hdr["ranges"].append((start, n))
        pos += 6
    hdr["header_ranges"] = list(hdr["ranges"])
    hdr["vheaders"] = {}
    pos = header_len
    while pos + 4 <= data_offset:
        length = struct.unpack_from("<H", data, pos)[0]
        if length < 4:
            break
        code, payload = data[pos + 2:pos + 4].decode(errors="replace"), data[pos + 4:pos + length]
        if code == "ED":
            code = payload[:2].decode(errors="replace")
            off, n = struct.unpack_from("<QI", payload, 2)
            payload = data[off:off + n]
        hdr["vheaders"][code] = payload
        pos += length
    if "SR" in hdr["vheaders"]:
        sr = hdr["vheaders"]["SR"]
        hdr["ranges"] = [(int.from_bytes(sr[i:i + 3], "little"), int.from_bytes(sr[i + 3:i + 6], "little"))
                         for i in range(0, len(sr) - 5, 6)]
    if ctype == 0:
        raw = data[data_offset:]
    else:
        if ctype == 1 and zstandard is None:
            pytest.skip("reading zstd FSEQ needs the zstandard module")
        raw = b""
        off = data_offset
        for _, length in blocks:
            if length:
                raw += _decompress(ctype, data[off:off + length])
            off += length
    assert len(raw) >= count * channels, (
        f"{path}: {len(raw)} bytes of frame data for {count} frames of {channels} channels")
    return hdr, [raw[i * channels:(i + 1) * channels] for i in range(count)]


@pytest.fixture
def src(tmp_path):
    """A 20-frame, 64-channel v2 uncompressed sequence written by FPP, with
    every frame different and no zero channels."""
    path = str(tmp_path / "src.fseq")
    frames = unique_frames(FRAMES, CHANNELS)
    write_fseq(path, frames, step_ms=25, media="song.mp3")
    return path, frames


def test_json_describes_every_version_and_compression(tmp_path):
    """-j reports what the file's header says, for v1 and for v2 in each
    compression, with its variable headers and sparse ranges."""
    frames = unique_frames(FRAMES, CHANNELS)
    cases = [
        (dict(version=1), "1.0", None),
        (dict(compression=None), "2.0", "none"),
        (dict(compression="zstd"), "2.0", "zstd"),
        (dict(compression="zlib"), "2.0", "zlib"),
    ]
    for kw, version, comp in cases:
        path = str(tmp_path / f"{version}-{comp}.fseq")
        write_fseq(path, frames, step_ms=40, media="show.mp3", **kw)
        j = info(path)
        assert j["Name"] == os.path.basename(path), j
        assert j["Version"] == version, j
        assert j["StepTime"] == 40 and j["NumFrames"] == FRAMES, j
        assert j["ChannelCount"] == CHANNELS and j["MaxChannel"] == CHANNELS, j
        assert j.get("variableHeaders", {}).get("mf") == "show.mp3", j
        if comp:
            assert j["CompressionTypeString"] == comp, j
        else:
            assert "CompressionType" not in j, j

    path = str(tmp_path / "sparse.fseq")
    write_fseq(path, frames, sparse=[(4, 8), (40, 10)])
    j = info(path)
    assert j["Ranges"] == [{"Start": 4, "Length": 8}, {"Start": 40, "Length": 10}], j
    assert j["ChannelCount"] == 18, j


def test_json_escapes_the_file_name(tmp_path):
    """A file name with a quote, a backslash, a tab and a newline in it still
    comes out as valid JSON, naming the file exactly."""
    name = 'a "quoted"\\ name\twith\na newline.fseq'
    path = str(tmp_path / name)
    write_fseq(path, unique_frames(2, CHANNELS))
    rc, out, err = fsequtils("-j", path)
    assert rc == 0, out + err
    assert json.loads(out)["Name"] == name, out


def test_convert_round_trips_every_version_and_compression(src, tmp_path):
    """Writing the sequence out again as v1, and as v2 uncompressed, zstd,
    zlib and v2.1, keeps every frame of every channel.

    Regression: c0400c58d. The zlib writer never ended the deflate stream of
    its last block or freed the stream, so every zlib file written leaked
    about 260 KB (LeakSanitizer fails the run here).

    Also covers be17a58e8: a zlib write with no zstd writer made first in the
    process (each conversion here is its own fsequtils run) got a 0-byte
    output buffer, and deflate() spun forever on it."""
    path, frames = src
    for fmt, comp, major, minor, ctype in (("1", "none", 1, 0, 0), ("2", "none", 2, 0, 0),
                                           ("2", "zstd", 2, 0, 1), ("2", "zlib", 2, 0, 2),
                                           ("2.1", "zstd", 2, 1, 1)):
        out = str(tmp_path / f"out-{fmt}-{comp}.fseq")
        rc, stdout, err = fsequtils("-f", fmt, "-c", comp, "-o", out, path)
        assert rc == 0, stdout + err
        hdr, got = read_fseq(out)
        what = f"-f {fmt} -c {comp}"
        assert (hdr["major"], hdr["minor"]) == (major, minor), (what, hdr)
        assert hdr["compression"] == ctype, (what, hdr)
        assert hdr["step"] == 25 and hdr["channels"] == CHANNELS, (what, hdr)
        assert len(got) == FRAMES, (what, hdr)
        bad = [i for i in range(FRAMES) if got[i] != frames[i]]
        assert not bad, f"{what}: frames {bad} differ, first {list(got[bad[0]][:16])}"
        if major == 2:
            assert info(out).get("variableHeaders", {}).get("mf") == "song.mp3", what


def test_compression_level_is_accepted(src, tmp_path):
    """-l passes a compression level through: the highest zstd level makes a
    file no larger than the lowest, and both read back intact."""
    path, frames = src
    sizes = {}
    for level in (1, 19):
        out = str(tmp_path / f"l{level}.fseq")
        rc, stdout, err = fsequtils("-c", "zstd", "-l", level, "-o", out, path)
        assert rc == 0, stdout + err
        assert read_fseq(out)[1] == frames, f"-l {level}"
        sizes[level] = os.path.getsize(out)
    assert sizes[19] <= sizes[1], sizes


def test_ranges_write_a_sparse_file(src, tmp_path):
    """-r before any merge picks the channels to keep: "11-20" is start-end
    and "41+8" is start+count, both 1-based. The result is a sparse v2 file
    holding exactly those channels."""
    path, frames = src
    out = str(tmp_path / "sparse.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-r", "11-20", "-r", "41+8", "-o", out, path)
    assert rc == 0, stdout + err
    hdr, got = read_fseq(out)
    assert hdr["ranges"] == [(10, 10), (40, 8)], hdr
    assert hdr["channels"] == 18, hdr
    want = [f[10:20] + f[40:48] for f in frames]
    bad = [i for i in range(FRAMES) if got[i] != want[i]]
    assert not bad, f"frames {bad}: {list(got[bad[0]])} != {list(want[bad[0]])}"
    assert info(out)["Ranges"] == [{"Start": 10, "Length": 10}, {"Start": 40, "Length": 8}]


def test_no_sparse_keeps_the_ranges_in_place(src, tmp_path):
    """-n with -r reads only the range but writes a full, non-sparse file:
    the range's channels sit where they were, and every other channel is 0.

    Regression: 25414d96e. The frame buffer was never cleared, so the
    channels outside the range were whatever the heap held (0xbe under
    ASan; usually zeros otherwise, from a fresh mmap)."""
    path, frames = src
    out = str(tmp_path / "full.fseq")
    rc, stdout, err = fsequtils("-n", "-c", "none", "-r", "11-20", "-o", out, path)
    assert rc == 0, stdout + err
    hdr, got = read_fseq(out)
    assert hdr["ranges"] == [] and hdr["channels"] == CHANNELS, hdr
    bad = [i for i in range(FRAMES) if got[i][10:20] != frames[i][10:20]]
    assert not bad, f"frames {bad}: the range moved or changed"
    bad = [i for i in range(FRAMES) if any(got[i][:10] + got[i][20:])]
    assert not bad, f"frames {bad}: channels outside the range aren't 0, first {list(got[bad[0]])}"


def merge_inputs(tmp_path):
    """A base sequence, and an overlay that is zero except in channels 8-15."""
    base = [bytes([(i + c) % 200 + 1 for c in range(CHANNELS)]) for i in range(FRAMES)]
    over = [bytes(8) + bytes([250 - i] * 8) + bytes(CHANNELS - 16) for i in range(FRAMES)]
    a, b = str(tmp_path / "base.fseq"), str(tmp_path / "over.fseq")
    write_fseq(a, base)
    write_fseq(b, over)
    return a, b, base, over


def test_merge_ignores_zeros_and_copy_zero_does_not(tmp_path):
    """-m lays a second sequence over the first wherever it is non-zero; -M
    copies its zeros too, blanking the base everywhere the overlay is dark."""
    a, b, base, over = merge_inputs(tmp_path)
    out = str(tmp_path / "m.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-o", out, "-m", b, a)
    assert rc == 0, stdout + err
    _, got = read_fseq(out)
    want = [x[:8] + y[8:16] + x[16:] for x, y in zip(base, over)]
    bad = [i for i in range(FRAMES) if got[i] != want[i]]
    assert not bad, f"-m: frames {bad} wrong, first {list(got[bad[0]][:20])}"

    out = str(tmp_path / "M.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-o", out, "-M", b, a)
    assert rc == 0, stdout + err
    _, got = read_fseq(out)
    bad = [i for i in range(FRAMES) if got[i] != over[i]]
    assert not bad, f"-M: frames {bad} are not the overlay, first {list(got[bad[0]][:20])}"


def test_merge_range_limits_what_is_merged(tmp_path):
    """-r after -m limits the merge to that range of the merged sequence:
    the rest of the base is untouched, even where the overlay is lit."""
    a, b, base, over = merge_inputs(tmp_path)
    out = str(tmp_path / "m.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-o", out, "-M", b, "-r", "13-16", a)
    assert rc == 0, stdout + err
    _, got = read_fseq(out)
    want = [x[:12] + y[12:16] + x[16:] for x, y in zip(base, over)]
    bad = [i for i in range(FRAMES) if got[i] != want[i]]
    assert not bad, f"frames {bad} wrong, first {list(got[bad[0]][:20])}"


def test_merge_range_past_the_channel_space_is_dropped(tmp_path):
    """A merge range that runs past the 8M-channel space stops at its end
    instead of writing past the buffer, and the file still comes out."""
    a, b, base, _ = merge_inputs(tmp_path)
    out = str(tmp_path / "m.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-o", out, "-M", b, "-r", "8388600+1000", a)
    assert rc == 0, stdout + err
    _, got = read_fseq(out)
    assert got == base, "a merge range past every channel changed the base"


def test_merge_of_a_shorter_sequence_leaves_the_rest_of_the_base(tmp_path):
    """Merging a sequence with fewer frames than the base lays it over the
    base's first frames only; the base's later frames come out unchanged.

    Regression: cb08077be. The merge loop asked the shorter file for every
    frame of the base and read through the null getFrame() returns past its
    end: fsequtils crashed with no output."""
    a, b, base, over = merge_inputs(tmp_path)
    short = str(tmp_path / "short.fseq")
    write_fseq(short, over[:FRAMES // 2])
    out = str(tmp_path / "m.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-o", out, "-m", short, a)
    assert rc == 0, stdout + err
    _, got = read_fseq(out)
    assert len(got) == FRAMES, len(got)
    want = [x[:8] + y[8:16] + x[16:] for x, y in zip(base, over)][:FRAMES // 2] + base[FRAMES // 2:]
    bad = [i for i in range(FRAMES) if got[i] != want[i]]
    assert not bad, f"frames {bad} wrong, first {list(got[bad[0]][:20])}"


def test_dump_prints_each_frame_of_the_range(src):
    """-d -r prints a titled hex dump of the range for every frame.

    Regression: c0400c58d. The dump never freed its 8 MB channel buffer,
    which LeakSanitizer reported on every dump."""
    path, frames = src
    rc, out, err = fsequtils("-d", "-r", "1-16", path)
    assert rc == 0, out + err
    text = out + err
    for i in (0, FRAMES - 1):
        assert f"Frame: {i}, Range: 0-15" in text, text[-3000:]
        assert " ".join(f"{b:02x}" for b in frames[i][:4]) in text.lower(), (i, text[-3000:])
    assert f"Frame: {FRAMES}," not in text


def test_dump_without_a_range_is_refused(src):
    rc, out, err = fsequtils("-d", src[0])
    assert rc == 1 and "No channel range specified" in out, out + err


def test_dump_past_the_channel_space_is_cut_short(src):
    """A dump range that runs past the 8M-channel space is cut off at its
    end rather than read beyond the buffer."""
    rc, out, err = fsequtils("-d", "-r", "8388600+100", src[0])
    assert rc == 0, out + err
    assert "Frame: 0, Range: 8388599-8388607" in out + err, out + err


def test_no_output_file_reads_and_stops(src):
    rc, out, err = fsequtils(src[0])
    assert rc == 0 and "No output file defined!" in out, out + err


def test_command_line_errors(src, tmp_path):
    """Help, version, a missing file name, an unknown option or compression
    type, and an input that does not exist."""
    rc, out, _ = fsequtils("-h")
    assert rc == 0 and "Usage:" in out, out
    rc, out, _ = fsequtils("-V")
    assert rc == 0 and out.strip(), out
    rc, out, _ = fsequtils()
    assert rc == 1 and "Usage:" in out, out
    rc, out, _ = fsequtils("-Z", src[0])
    assert rc != 0 and "Usage:" in out, out
    rc, out, _ = fsequtils("-c", "lz4", "-o", str(tmp_path / "x.fseq"), src[0])
    assert rc != 0 and "Unknown compression type: lz4" in out, out
    # An input that does not exist writes nothing (it exits 0 all the same).
    rc, out, err = fsequtils("-o", str(tmp_path / "y.fseq"), str(tmp_path / "missing.fseq"))
    assert not os.path.exists(tmp_path / "y.fseq"), out + err
