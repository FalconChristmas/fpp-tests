"""Match frames seen on the wire back to the sequence frames they came from.

Every source frame is unique (fseq.unique_frames), so a received frame's
bytes name its index without any timing assumptions. From the sequence of
indices fall out drops, repeats, reordering, corruption and black padding.
"""

from dataclasses import dataclass, field
from statistics import median


@dataclass
class Fidelity:
    matched: int = 0
    unknown: int = 0          # neither black nor any source frame: corrupted
    leading_black: int = 0
    trailing_black: int = 0
    interior_black: int = 0
    repeats: int = 0          # same index again, back to back
    backwards: int = 0        # index lower than the one before
    first_index: int = None
    last_index: int = None
    distinct: int = 0
    dropped: int = 0          # indices missing between first and last
    first_time: float = None  # arrival of the first matched frame
    cadence_ms: float = None  # median gap between consecutive indices
    indices: list = field(default_factory=list)

    def summary(self):
        return (f"matched {self.matched}, distinct {self.distinct} "
                f"[{self.first_index}..{self.last_index}], dropped {self.dropped}, "
                f"repeats {self.repeats}, backwards {self.backwards}, unknown {self.unknown}, "
                f"black lead/interior/trail {self.leading_black}/{self.interior_black}/"
                f"{self.trailing_black}, cadence {self.cadence_ms} ms")


def analyze(source_frames, received):
    """source_frames: list of bytes; received: list of (time, bytes)."""
    width = len(source_frames[0])
    lookup = {}
    for i, f in enumerate(source_frames):
        assert f not in lookup, "source frames must be unique"
        lookup[f] = i
    seq = []  # (time, index or None for black, or -1 for unknown)
    for t, data in received:
        data = data[:width]
        if not any(data):
            seq.append((t, None))
        else:
            seq.append((t, lookup.get(data, -1)))

    r = Fidelity()
    while seq and seq[0][1] is None:
        r.leading_black += 1
        seq.pop(0)
    while seq and seq[-1][1] is None:
        r.trailing_black += 1
        seq.pop()
    prev = None
    times = {}
    for t, idx in seq:
        if idx is None:
            r.interior_black += 1
            continue
        if idx == -1:
            r.unknown += 1
            continue
        r.matched += 1
        r.indices.append(idx)
        times.setdefault(idx, t)
        if r.first_time is None:
            r.first_time = t
        if prev is not None:
            if idx == prev:
                r.repeats += 1
            elif idx < prev:
                r.backwards += 1
        prev = idx
    if r.indices:
        seen = set(r.indices)
        r.first_index, r.last_index = min(seen), max(seen)
        r.distinct = len(seen)
        r.dropped = (r.last_index - r.first_index + 1) - r.distinct
        gaps = [(times[b] - times[a]) * 1000 / (b - a)
                for a, b in zip(sorted(times), sorted(times)[1:])]
        if gaps:
            r.cadence_ms = round(median(gaps), 1)
    return r
