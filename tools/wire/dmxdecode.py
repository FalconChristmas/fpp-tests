"""Decode a padsample capture as DMX (or any 8-bit async serial) and check it.

usage: dmxdecode.py capture.txt baud expected-hex-pattern [stopbits]
Frames start at a low run >= 88us.  Each slot is sampled at bit centres from its
start-bit edge; a slot whose sample points are not all inside watched time is
'unknown' and the decoder resyncs on the next falling edge.
"""
import bisect, sys

path, baud, pat = sys.argv[1], float(sys.argv[2]), bytes.fromhex(sys.argv[3])
stopbits = int(sys.argv[4]) if len(sys.argv) > 4 else 2
lines = open(path).read().split("\n")
f = int(lines[0].split()[1]); samples = int(lines[0].split()[2])
ev = [(l[0], int(l[2:])) for l in lines[1:] if l]
T = f / baud                      # ticks per bit
us = f / 1e6

edges = []                        # (t, level) level after t
gaps = []                         # (t0, t1) unwatched
start, level0 = ev[0][1], 1 if ev[0][0] == "H" else 0
edges.append((start, level0))
for k, t in ev[1:]:
    if k in "LH":
        edges.append((t, 1 if k == "H" else 0))
    elif k == "g":
        g0 = t
    else:
        gaps.append((g0, t))
endt = ev[-1][1]
et = [e[0] for e in edges]
gs = [g[0] for g in gaps]

def level(t):
    i = bisect.bisect_right(et, t) - 1
    return edges[i][1]

def watched(t0, t1):
    i = bisect.bisect_right(gs, t1)
    for g in gaps[max(0, i - 3):i + 1]:
        if g[0] < t1 and g[1] > t0:
            return False
    return start <= t0 and t1 <= endt

# frames: falling edge followed by a low run >= 88us that was watched throughout
breaks = []
timed = []
inferred = 0
for i in range(len(edges) - 1):
    t, lv = edges[i]
    if lv == 0:
        t1 = edges[i + 1][0]
        # A gap ending at the falling edge only hides an earlier start, so the
        # run is at least as long as measured; a gap after it can hide data
        # edges and fake a long low.  Only fully watched ones are timed.
        if (t1 - t) >= 88 * us and watched(t + 1, t1):
            breaks.append((t, t1))
            if watched(t, t1):
                timed.append((t, t1))
        elif (t1 - t) >= 88 * us and i + 2 < len(edges) and edges[i + 2][1] == 0:
            # a gap inside: accept it only when what follows is a watched,
            # correctly framed 00 start code, which the pattern never contains
            s0 = edges[i + 2][0]
            p = [s0 + (k + 0.5) * T for k in range(1 + 8 + stopbits)]
            if s0 - t1 < 100 * us and watched(t1, p[-1]) and not any(level(x) for x in p[:9]) and all(level(x) for x in p[9:]):
                breaks.append((t, t1))
                inferred += 1
print(f"capture {(endt - start) / f:.3f}s, {samples} samples ({(endt - start) / max(samples,1) / us * 1000:.0f} ns/sample), {len(gaps)} gaps, max gap {max([(b - a) / us for a, b in gaps] or [0]):.1f}us")
print(f"frames (breaks seen): {len(breaks)} ({inferred} with a gap inside, accepted on a following 00 start code)")
if not breaks:
    sys.exit(1)
blen = [(b - a) / us for a, b in timed]
print(f"break length us ({len(timed)} fully watched): min {min(blen):.1f} max {max(blen):.1f}")
per = [(breaks[i + 1][0] - breaks[i][0]) / us / 1000 for i in range(len(breaks) - 1)]
if per:
    print(f"break-to-break ms: min {min(per):.2f} max {max(per):.2f}")

good = bad = unknown = 0
mab = []
bitw = []
badlist = []
frames_complete = 0
periods = []
badslots = []
for bi, (b0, b1) in enumerate(breaks):
    nxt = breaks[bi + 1][0] if bi + 1 < len(breaks) else endt
    # first falling edge after the break ends = start bit of slot 0
    j = bisect.bisect_right(et, b1)
    if j < len(edges) and edges[j][1] == 0 and edges[j][0] < nxt and watched(b1, edges[j][0]):
        mab.append((edges[j][0] - b1) / us)
    slot = 0
    fgood = 0
    first = None                 # start-bit time of slot 0
    lastSeen = None              # (slot, start time) of the last watched character
    period = None                # character period, measured inside this frame
    slots_this = 0
    while j < len(edges) and edges[j][0] < nxt:
        t0, lv = edges[j]
        if lv != 0:
            j += 1
            continue
        nbits = 1 + 8 + stopbits
        pts = [t0 + (k + 0.5) * T for k in range(nbits)]
        if not watched(t0 - 2 * T, pts[-1]):
            unknown += 1
            slot = None          # position lost until re-derived from time
        else:
            if slot is not None and slot > 0 and lastSeen is not None and lastSeen[0] == slot - 1:
                # a start edge a gap hid makes the first edge after it a data
                # edge: the next start has to be one character period on
                fper = (lastSeen[1] - first) / lastSeen[0] if first is not None and lastSeen[0] > 0 else period
                if fper is not None and abs(t0 - (lastSeen[1] + fper)) > 1 * us:
                    slot = None
            if slot is None:
                # After a gap the first falling edge may be a data edge, so a
                # candidate start bit has to frame (start 0, stop bits 1) and
                # land within 1us of a whole number of character periods from
                # the last watched character; otherwise try the next edge.
                bits = [level(p) for p in pts]
                fper = period
                if first is not None and lastSeen is not None and lastSeen[0] > 0:
                    fper = (lastSeen[1] - first) / lastSeen[0]
                if lastSeen is None or fper is None or bits[0] != 0 or not all(bits[9:]):
                    j += 1
                    continue
                n = (t0 - lastSeen[1]) / fper
                if abs(n - round(n)) * fper > 1 * us:
                    j += 1
                    continue
                slot = lastSeen[0] + round(n)
            if first is None and slot == 0:
                first = t0
            if lastSeen is not None and slot == lastSeen[0] + 1 and period is None:
                period = t0 - lastSeen[1]
            bits = [level(p) for p in pts]
            val = sum(bits[1 + k] << k for k in range(8))
            exp = 0 if slot == 0 else pat[(slot - 1) % len(pat)]
            ok = bits[0] == 0 and all(bits[9:]) and val == exp
            if ok:
                good += 1; fgood += 1
            else:
                bad += 1
                badslots.append(slot)
                if len(badlist) < 10:
                    badlist.append((bi, slot, hex(val), hex(exp), bits))
            # measured bit width from the data edges inside this slot
            for k in range(1, 9):
                if bits[k] != bits[k - 1]:
                    ii = bisect.bisect_left(et, pts[k - 1])
                    if ii < len(et) and et[ii] < pts[k]:
                        bitw.append(((et[ii] - t0) / k) / us)
            lastSeen = (slot, t0)
            slots_this = max(slots_this, slot + 1)
            slot += 1
        # skip to after this character's stop bits
        tnext = t0 + (nbits - 0.5) * T
        j = bisect.bisect_right(et, tnext)
    if slots_this == 513:
        frames_complete += 1
    elif bi + 1 < len(breaks):
        print(f"frame {bi}: last slot seen {slots_this - 1}")
    if period:
        periods.append(period / us)
if periods:
    print(f"character period us: min {min(periods):.3f} max {max(periods):.3f} (11 bits = {11e6/baud:.1f})")
print(f"slots good {good}  bad {bad}  unknown(gap) {unknown}; frames reaching slot 512: {frames_complete}")
if mab:
    print(f"mark-after-break us: min {min(mab):.1f} max {max(mab):.1f}")
if bitw:
    bitw.sort()
    print(f"bit time us (from data edges): median {bitw[len(bitw)//2]:.4f} min {bitw[0]:.4f} max {bitw[-1]:.4f}  (nominal {1e6/baud:.4f})")
print(f"bad slots at positions <= 512: {sum(1 for x in badslots if x <= 512)}, past 512 (frames merged over a missed break): {sum(1 for x in badslots if x > 512)}")
for b in badlist:
    print("BAD", b)
sys.exit(0 if bad == 0 and good > 0 else 2)
