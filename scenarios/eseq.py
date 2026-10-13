"""Write ESEQ effect files (docs/ESEQ_Effect_Sequence_file_format.txt).

An ESEQ holds one model: a 1-based start channel, a size, and then the
model's channels for each frame, back to back. fppd plays them at a fixed
50 ms a frame.
"""

import struct

STEP_MS = 50


def eseq_bytes(frames, start_channel, step=None):
    """The file for `frames` (equal-length bytes, the model's own channels)
    placed at 1-based `start_channel`. `step` is the row width the header
    claims (the model size by default)."""
    size = len(frames[0])
    step = size if step is None else step
    header = b"ESEQ" + struct.pack("<B3xIII", 1, step, start_channel, size)
    return header + b"".join(frames)


def write_eseq(fppd, name, frames, start_channel):
    """effects/<name>.eseq in the scenario's media directory."""
    return fppd.write(f"effects/{name}.eseq", eseq_bytes(frames, start_channel))


def model_frames(count, size, seed=0):
    """Frames whose every channel is non-zero and whose content names the
    frame, so a model's channels read off the wire identify the frame."""
    return [bytes(((i + seed) * 13 + c) % 250 + 1 for c in range(size)) for i in range(count)]


def solid(count, size, value):
    return [bytes([value]) * size for _ in range(count)]
