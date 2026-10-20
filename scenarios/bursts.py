"""Timing sound against a reference with coded tone bursts, streamed.

A burst track has a 100 ms tone every 2 s from 1 s in; burst k sounds at
CODES[k % 10] Hz, so a burst heard can be matched to the one it is even when
it lands seconds away. StreamRecorder reads pw-record's output as it comes
and keeps only the bursts' onsets, so a long recording fits a 512 MB board.

A burst's time is the earliest the tap could have handed it over: the
minimum, over the reads that follow it, of (read time - samples after it /
rate). The recording taps a sink's monitor, so it is the graph's view of the
sound, not the DAC's: only differences and changes are meaningful on one box.
"""

import array
import bisect
import glob
import math
import struct
import subprocess
import threading
import time
import wave

from audio import env as audio_env

REC_RATE = 8000
CODES = [500 + 100 * c for c in range(10)]  # Hz for burst k: CODES[k % 10]


def burst_tone(path, secs, rate=44100, channels=2, amp=0.3, codes=CODES):
    """A wav of `secs` with the coded bursts. Only the bursts are computed."""
    total = int(secs * rate)
    pcm = array.array("h", bytes(2 * total * channels))
    for k in range(int((secs - 1) // 2)):
        s0 = int((1 + 2 * k) * rate)
        step = 2 * math.pi * codes[k % 10] / rate
        for i in range(s0, min(total, s0 + int(0.1 * rate))):
            v = int(amp * 32767 * math.sin(step * (i - s0)))
            for c in range(channels):
                pcm[i * channels + c] = v
    if array.array("h", [1]).tobytes() != b"\x01\x00":
        pcm.byteswap()
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def code_of(freq):
    return min(range(10), key=lambda c: abs(CODES[c] - freq))


class StreamRecorder:
    """pw-record of `sink` to a pipe: the reads' (time, samples so far) and
    the bursts' (sample index, peak, frequency)."""

    def __init__(self, sink, latency="1024/44100"):
        self.read_t = array.array("d")
        self.read_n = array.array("d")
        self.onsets = []
        self.total = 0
        # node.latency: pw-record asks for 100 ms otherwise, which drags the
        # graph's quantum up whenever nothing else is asking.
        self.proc = subprocess.Popen(
            ["pw-record", "--target", sink, "-P", "stream.capture.sink=true",
             "-P", f"node.latency={latency}",
             "--rate", str(REC_RATE), "--channels", "1", "--format", "s16", "--raw", "-"],
            env=audio_env(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        quiet = REC_RATE
        cand = None
        carry = b""
        while True:
            chunk = self.proc.stdout.read(4096)
            if not chunk:
                break
            t = time.monotonic()
            chunk = carry + chunk
            n = len(chunk) // 2
            carry = chunk[2 * n:]
            xs = struct.unpack(f"<{n}h", chunk[:2 * n])
            base = self.total
            self.total += n
            self.read_t.append(t)
            self.read_n.append(self.total)
            if cand is None and max(xs, default=0) <= 130 and min(xs, default=0) >= -130:
                quiet += n
                continue
            for j, x in enumerate(xs):
                ax = abs(x)
                if cand is not None:
                    cand[1].append(x)
                    if len(cand[1]) >= int(0.12 * REC_RATE):
                        self._burst(*cand)
                        cand = None
                elif ax > 130 and quiet > REC_RATE // 2:
                    cand = (base + j, [x])
                quiet = 0 if ax > 130 else quiet + 1

    def _burst(self, start, xs):
        peak = max(abs(x) for x in xs)
        first = next(i for i, x in enumerate(xs) if abs(x) >= 0.3 * peak)
        body = xs[first + int(0.02 * REC_RATE):first + int(0.08 * REC_RATE)]
        crossings = sum(1 for a, b in zip(body, body[1:]) if a < 0 <= b)
        self.onsets.append((start + first, peak / 32768, crossings / (len(body) / REC_RATE) if body else 0))

    def stop(self):
        self.proc.terminate()
        self.proc.wait(5)
        self.thread.join(5)

    def capture_time(self, n, rate, window=10.0):
        i = bisect.bisect_left(self.read_n, n)
        best, t_first = None, None
        for j in range(i, len(self.read_n)):
            t = self.read_t[j]
            if t_first is None:
                t_first = t
            if t - t_first > window:
                break
            c = t - (self.read_n[j] - n) / rate
            best = c if best is None else min(best, c)
        return best

    def burst_times(self, ppm=0.0):
        """[(monotonic time, frequency)] of every burst heard; ppm is the
        card's rate against the system clock, which the tap's samples run at."""
        rate = REC_RATE * (1 + ppm / 1e6)
        out = [(self.capture_time(n, rate), f) for n, _, f in self.onsets]
        return [o for o in out if o[0] is not None]


def card_status():
    """The first running playback substream's position, or None."""
    for path in sorted(glob.glob("/proc/asound/card*/pcm*p/sub*/status")):
        try:
            text = open(path).read()
        except OSError:
            continue
        if "state: RUNNING" not in text:
            continue
        f = {}
        for line in text.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                f[k.strip()] = v.strip()
        try:
            s, ns = f["tstamp"].split(".")
            return {"path": path, "hw": int(f["hw_ptr"]), "t": int(s) + int(ns) / 1e9,
                    "trigger": f.get("trigger_time", "")}
        except (KeyError, ValueError):
            continue
    return None


def card_ppm(statuses):
    """The card's rate against the system clock, fitted over the longest run
    of readings with one trigger time; 0 without enough of them."""
    segs = {}
    for st in statuses:
        segs.setdefault((st["path"], st["trigger"]), []).append(st)
    if not segs:
        return 0.0
    longest = max(segs.values(), key=len)
    if len(longest) < 10:
        return 0.0
    try:
        nominal = next(int(l.split()[1]) for l in open(longest[0]["path"].replace("/status", "/hw_params"))
                       if l.startswith("rate:"))
    except (OSError, StopIteration, ValueError):
        return 0.0
    ts = [s["t"] for s in longest]
    hw = [s["hw"] for s in longest]
    mt, mh = sum(ts) / len(ts), sum(hw) / len(hw)
    slope = sum((t - mt) * (h - mh) for t, h in zip(ts, hw)) / sum((t - mt) ** 2 for t in ts)
    return (slope / nominal - 1) * 1e6


def offsets_against(bursts, t0, count, window=5.0):
    """For bursts k < count expected at t0 + 1 + 2k: (k, heard - expected in
    ms) for each heard, matched by its code within `window` s."""
    out = []
    for k in range(count):
        expected = t0 + 1 + 2 * k
        c = [b for b in bursts if abs(b[0] - expected) < window and code_of(b[1]) == k % 10]
        if c:
            out.append((k, (min(c, key=lambda b: abs(b[0] - expected))[0] - expected) * 1000))
    return out
