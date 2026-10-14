#!/bin/sh
# Runs inside the container after a coverage-flavor run (run.sh). Turns the
# .gcda counts in the tree at $1 into reports under $2:
#   summary.txt     per-file line and function coverage, least covered first
#   functions.csv   every function with its call count, for finding the
#                   ones no scenario reaches
#   html/           browsable per-line detail
set -e
TREE="$1"
OUT="$2"
mkdir -p "$OUT/html"
cd "$TREE/src"
# Only fppd's own code: not the submodules, generated files or system headers.
FILTER='--filter '"$TREE"'/src/ --exclude '"$TREE"'/src/external/ --exclude .*/fppversion\..*'
gcovr -r "$TREE/src" $FILTER --gcov-ignore-errors=all --gcov-ignore-parse-errors=all \
    -j "$(nproc)" --json "$OUT/coverage.json" --html-details "$OUT/html/index.html" \
    --txt "$OUT/summary-by-name.txt" --print-summary
python3 - "$OUT" <<'PY'
import json, sys, os
out = sys.argv[1]
data = json.load(open(os.path.join(out, "coverage.json")))
rows, funcs = [], []
for f in data["files"]:
    lines = [l for l in f["lines"] if not l.get("gcovr/noncode")]
    hit = sum(1 for l in lines if l["count"] > 0)
    fn = f.get("functions", [])
    fhit = sum(1 for x in fn if x.get("execution_count", 0) > 0)
    rows.append((f["file"], len(lines), hit, len(fn), fhit))
    for x in fn:
        funcs.append((f["file"], x.get("lineno", 0), x.get("demangled_name") or x["name"], x.get("execution_count", 0)))
rows.sort(key=lambda r: (r[2] / r[1] if r[1] else 1, -r[1]))
with open(os.path.join(out, "summary.txt"), "w") as s:
    s.write(f"{'lines':>6} {'hit':>6} {'line%':>6} {'funcs':>6} {'hit':>5}  file\n")
    for name, n, h, fn, fh in rows:
        s.write(f"{n:6} {h:6} {100*h/n if n else 100:5.1f}% {fn:6} {fh:5}  {name}\n")
    tl, th = sum(r[1] for r in rows), sum(r[2] for r in rows)
    s.write(f"{tl:6} {th:6} {100*th/tl:5.1f}%  TOTAL\n")
with open(os.path.join(out, "functions.csv"), "w") as c:
    c.write("file,line,calls,function\n")
    for name, line, fn, n in sorted(funcs):
        c.write(f'{name},{line},{n},"{fn.replace(chr(34), chr(39))}"\n')
PY
