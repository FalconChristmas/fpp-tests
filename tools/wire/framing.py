"""Framing check for an async serial capture with no breaks (LOR, Renard).

usage: framing.py capture.txt baud
Only characters whose start edge follows at least 10 watched idle bit times (or
the stop bit of a watched character) are judged: a character's data can hold
up to 9 bit times of 1s with its stop bit, so a shorter high run before a
falling edge does not prove it is a start bit, and after a sampler gap that
mistake turns a data edge into a fake framing error.
"""
import bisect, collections, sys
L = open(sys.argv[1]).read().split("\n"); baud = float(sys.argv[2])
f = int(L[0].split()[1]); us = f / 1e6; T = f / baud
ev = [(l[0], int(l[2:])) for l in L[1:] if l]
edges = [(t, 1 if k == "H" else 0) for k, t in ev if k in "LH"]
gaps = []; g0 = None
for k, t in ev:
    if k == "g": g0 = t
    elif k == "G": gaps.append((g0, t))
et = [e[0] for e in edges]; gs = [g[0] for g in gaps]
def level(t): return edges[bisect.bisect_right(et, t) - 1][1]
def watched(a, b):
    i = bisect.bisect_right(gs, b)
    return not any(g[0] < b and g[1] > a for g in gaps[max(0, i - 3):i + 1])
good = bad = 0; widths = []; chars = collections.Counter(); prevEnd = None
j = 1
while j < len(edges):
    t0, lv = edges[j]
    if lv != 0: j += 1; continue
    pts = [t0 + (k + 0.5) * T for k in range(10)]
    synced = (prevEnd is not None and abs(t0 - prevEnd) < 0.3 * T) or \
             (level(t0 - 1) == 1 and watched(t0 - 10 * T, t0) and edges[j - 1][0] <= t0 - 10 * T)
    if synced and watched(t0, pts[-1]):
        bits = [level(p) for p in pts]
        if bits[0] == 0 and bits[9] == 1:
            good += 1; chars[sum(bits[1 + k] << k for k in range(8))] += 1
            for k in range(1, 9):
                if bits[k] != bits[k - 1]:
                    ii = bisect.bisect_left(et, pts[k - 1])
                    if ii < len(et) and et[ii] < pts[k]: widths.append((et[ii] - t0) / k / us)
        else:
            bad += 1
        prevEnd = t0 + 10 * T
    else:
        prevEnd = None
    j = bisect.bisect_right(et, t0 + 9.5 * T)
print(f"chars framed ok {good}, framing errors {bad}")
widths.sort()
if widths: print(f"bit time us: median {widths[len(widths)//2]:.4f} min {widths[0]:.4f} max {widths[-1]:.4f} (nominal {1e6/baud:.4f})")
print("most common bytes:", [(hex(b), n) for b, n in chars.most_common(6)])
sys.exit(0 if bad == 0 and good else 2)
