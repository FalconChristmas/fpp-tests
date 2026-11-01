"""fsequtils on sparse and very large sequences."""

import os
import struct

from fseq import unique_frames, write_fseq
from test_fsequtils import fsequtils, read_fseq

CHANNELS = 64
FRAMES = 20


def test_a_sparse_file_made_from_a_sparse_file_keeps_its_channels(tmp_path):
    """Writing a sparse file (-r) out of a file that is already sparse reads
    the source by channel number, whatever the source's stored channel
    count: a range that lies beyond the channels the source stores in all
    still gets its data.

    Regression: a03f4a27f (ported from xLights). The new file's channel
    count came from the sparse source's stored channel count, 18 here, so
    a range at channel 41 was cut off the channel space.
    """
    src = str(tmp_path / "src.fseq")
    frames = unique_frames(FRAMES, CHANNELS)
    write_fseq(src, frames, sparse=[(4, 8), (40, 10)])
    out = str(tmp_path / "out.fseq")
    rc, stdout, err = fsequtils("-c", "none", "-r", "41+8", "-o", out, src)
    assert rc == 0, stdout + err
    hdr, got = read_fseq(out)
    assert hdr["ranges"] == [(40, 8)], hdr
    bad = [i for i in range(FRAMES) if got[i] != frames[i][40:48]]
    assert not bad, f"frames {bad}: {list(got[bad[0]])} != {list(frames[bad[0]][40:48])}"


def test_a_compressed_file_over_4gib_is_split_into_blocks(tmp_path):
    """Compressing a sequence whose channels x frames is just over 2^32
    makes many compression blocks, not one block of every frame.

    Regression: d3f5eb8a2. The size was worked out in 32 bits, wrapped to a
    few KB, and the whole 4 GiB went into a single block.
    """
    channels, frames = 65536, 65537
    src = str(tmp_path / "big.fseq")
    # a real header (two frames), then claim more frames and make the file
    # as long as they need: the rest is a hole, read back as zeros
    write_fseq(src, unique_frames(2, channels))
    with open(src, "r+b") as f:
        f.seek(14)
        f.write(struct.pack("<I", frames))
        data_offset = struct.unpack("<H", (f.seek(4), f.read(2))[1])[0]
        f.truncate(data_offset + channels * frames)
    out = str(tmp_path / "out.fseq")
    rc, stdout, err = fsequtils("-c", "zstd", "-o", out, src, timeout=550)
    try:
        assert rc == 0, stdout + err
        with open(out, "rb") as f:
            head = f.read(24)
        _, nblocks_lo = head[20] >> 4, head[21]
        nblocks = ((head[20] >> 4) << 8) | nblocks_lo
        assert struct.unpack_from("<I", head, 14)[0] == frames
        assert nblocks > 100, f"{nblocks} compression blocks for {channels * frames} bytes"
    finally:
        for p in (src, out):
            if os.path.exists(p):
                os.unlink(p)
