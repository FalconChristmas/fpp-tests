"""Write FSEQ sequence files for scenarios.

write_fseq() uses FPP's own writer (FSEQFile, from the tree under test, via
tools/fseqgen.cpp), so every scenario that plays a sequence exercises the
writer as well as the reader. write_fseq_reference() is an independent
writer from docs/FSEQ_Sequence_File_Format.txt, for checking the reader
against files FPP didn't write.

Frames are always given indexed by absolute channel (0-based), as fppd's
channel data is; with sparse ranges only those channels are stored.
"""

import os
import shutil
import struct
import subprocess
import tempfile
import zlib

try:
    import zstandard
except ImportError:  # only the zstd variant needs it
    zstandard = None

V2_HEADER = 32


def unique_frames(count, channels, first=0):
    """Frames whose content identifies them: the first three channels carry
    the frame index (plus one, so no frame is all zero) and the rest a fill
    that changes with it. A frame read back off the wire names its index.
    `first` numbers them from there, to keep several sequences distinct."""
    frames = []
    for i in range(first, first + count):
        n = i + 1
        head = bytes([(n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF])
        fill = bytes([(n * 37 + c) % 251 + 1 for c in range(channels - 3)])
        frames.append((head + fill)[:channels])
    return frames


def solid_frames(count, channels, value):
    return [bytes([value]) * channels for _ in range(count)]


def _variable_header(code, text):
    data = text.encode() + b"\0"
    return struct.pack("<H", len(data) + 4) + code.encode() + data


_FSEQGEN = None


def _sanitizer_flags(libfpp):
    """The helper must carry the same sanitizer runtime as libfpp."""
    out = subprocess.run(["ldd", libfpp], capture_output=True, text=True).stdout
    for lib, flag in (("libasan", "address"), ("libtsan", "thread"), ("libubsan", "undefined")):
        if lib in out:
            return [f"-fsanitize={flag}"]
    return []


def fseqgen():
    """Build tools/fseqgen.cpp against the tree under test, once per run."""
    global _FSEQGEN
    if _FSEQGEN:
        return _FSEQGEN
    src = os.path.join(os.environ["FPP_TREE"], "src")
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(tempfile.mkdtemp(prefix="fseqgen-"), "fseqgen")
    cmd = ["c++", "-std=gnu++20", "-O1", "-g", *_sanitizer_flags(os.path.join(src, "libfpp.so")),
           f"-I{src}", "-I/usr/include/jsoncpp", os.path.join(here, "tools", "fseqgen.cpp"),
           f"-L{src}", "-lfpp", f"-Wl,-rpath,{src}", "-o", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("building fseqgen failed:\n" + r.stderr[-4000:])
    _FSEQGEN = out
    return out


def write_fseq(path, frames, step_ms=50, version=2, compression=None, level=-99,
               sparse=None, media=None, minor=None):
    """Write `frames` (equal-length bytes, indexed by absolute channel) to
    `path` with FPP's FSEQFile writer.

    compression: None, "zlib" or "zstd" (version 2 only).
    sparse:      [(start_channel_0_based, count), ...] to store only those.
    media:       media filename for the 'mf' variable header.
    """
    space = len(frames[0])
    cmd = [fseqgen(), path, str(version), compression or "none", str(level), str(step_ms), str(space)]
    if minor is not None:
        cmd += ["--minor", str(minor)]
    if sparse:
        cmd += ["--sparse", ",".join(f"{s}:{n}" for s, n in sparse)]
    if media:
        cmd += ["--media", media]
    env = dict(os.environ)
    env["ASAN_OPTIONS"] = "detect_leaks=0"
    r = subprocess.run(cmd, input=b"".join(frames), capture_output=True, env=env)
    if r.returncode:
        raise RuntimeError(f"fseqgen failed ({r.returncode}): {r.stderr.decode(errors='replace')[-4000:]}")
    return path


def write_fseq_reference(path, frames, step_ms=50, version=2, compression=None, blocks=1,
                         sparse=None, media=None, streams=1, sr=None, range_count=None):
    """The same file written independently of FPP (see the module docs).

    blocks:  number of compression blocks the frames are split into.
    streams: compressed streams each block is made of, back to back (the
             format allows several; FPP's writer makes one).
    sparse:  more than 255 ranges are stored as FSEQ 2.3 stores them: the
             first 255 in the header, counted as 255, and the whole table in
             an 'SR' header kept as extended data after the channel data.
    sr:      the 'SR' table to write in place of `sparse` (a stale one).
    range_count: the header's range count, with all of `sparse` in the
             header's table: how writers before 2.3 stored a longer table.
    """
    if sparse:
        frames = [b"".join(f[s:s + n] for s, n in sparse) for f in frames]
    count = len(frames)
    channels = len(frames[0]) if frames else 0
    vheaders = _variable_header("sp", "fpp-tests")
    if media:
        vheaders = _variable_header("mf", media) + vheaders

    if version == 1:
        assert compression is None and sparse is None
        header_len = 28
        data_offset = header_len + len(vheaders)
        header = b"PSEQ" + struct.pack(
            "<HBBHIIBBHHBBH", data_offset, 0, 1, header_len, channels, count,
            step_ms, 0, 0, 0, 1, 2, 0)
        with open(path, "wb") as f:
            f.write(header + vheaders + b"".join(frames))
        return path

    ctype = {None: 0, "zstd": 1, "zlib": 2}[compression]
    if ctype == 0:
        blocks = 0
    sparse = sparse or []
    table = sparse
    if range_count is None:
        if sr is None and len(sparse) > 255:
            sr = sparse
        table = sparse[:255]
        range_count = len(table)
    if ctype:
        per = -(-count // blocks)
        chunks = [(i, frames[i:i + per]) for i in range(0, count, per)]
        blobs = []
        for first, chunk in chunks:
            raw = b"".join(chunk)
            cut = -(-len(raw) // streams)
            parts = [raw[i:i + cut] for i in range(0, len(raw), cut)]
            if ctype == 1:
                if zstandard is None:
                    raise RuntimeError("zstd FSEQ needs the zstandard module")
                blobs.append((first, b"".join(zstandard.ZstdCompressor().compress(p) for p in parts)))
            else:
                blobs.append((first, b"".join(zlib.compress(p) for p in parts)))
        nblocks = len(blobs)
    else:
        blobs = []
        nblocks = 0

    def pack_ranges(rs):
        return b"".join(struct.pack("<I", s)[:3] + struct.pack("<I", n)[:3] for s, n in rs)

    index = b"".join(struct.pack("<II", first, len(b)) for first, b in blobs)
    ranges = pack_ranges(table)
    header_len = V2_HEADER + len(index) + len(ranges)
    body = b"".join(b for _, b in blobs) if ctype else b"".join(frames)
    extended = b""
    minor = 0
    if sr is not None:
        extended = pack_ranges(sr)
        minor = 3
        # 'ED' entry: inner code, then the 64-bit offset and 32-bit length of the data.
        offset = header_len + len(vheaders) + 18 + len(body)
        vheaders += struct.pack("<H", 18) + b"EDSR" + struct.pack("<QI", offset, len(extended))
    data_offset = header_len + len(vheaders)
    header = b"PSEQ" + struct.pack(
        "<HBBHIIBBBBBBQ", data_offset, minor, 2, header_len, channels, count, step_ms,
        0, ctype | ((nblocks >> 8) << 4), nblocks & 0xFF, range_count & 0xFF, 0,
        0x5EED)
    with open(path, "wb") as f:
        f.write(header + index + ranges + vheaders + body + extended)
    return path
