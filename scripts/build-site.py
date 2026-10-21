#!/usr/bin/env python3
"""The nightly dashboard published to GitHub Pages.

    scripts/build-site.py RESULTS SITE HISTORY RUN_URL

RESULTS holds this run's results-<flavor> artifacts (see ci_results.py),
each in a directory of its own, or unpacked into RESULTS itself when there
was only one. HISTORY is the published
site's history.json, or a missing file for the first run. Writes
SITE/index.html and SITE/history.json, with this run added to the history.
The workflow puts the coverage report's HTML in SITE/coverage/ itself.
"""

import datetime
import html
import json
import os
import sys

import ci_results

results, site, history_file, run_url = sys.argv[1:5]
FLAVORS = ["asan", "tsan", "coverage", "pi5", "web"]
LABEL = {"asan": "ASan", "tsan": "TSan", "coverage": "coverage build", "pi5": "Pi 5",
         "web": "web UI"}
FPP_COMMIT = "https://github.com/FalconChristmas/fpp/commit/"
README = "https://github.com/FalconChristmas/fpp-tests#writing-a-scenario"

try:
    with open(history_file) as f:
        history = json.load(f)
except (OSError, ValueError):
    history = []
history = [h for h in history if h.get("flavors")]

# This run.
entry = {"date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
         "run": run_url, "flavors": {}}
cov = None
for art in sorted(d for d, _, files in os.walk(results) if "meta.json" in files):
    m = ci_results.meta(art)
    if not m:
        continue
    entry["fpp"], entry["sha"] = m.get("version", "?"), m.get("sha", "")
    r = ci_results.tests(art)
    entry["flavors"][m["flavor"]] = None if r is None else {
        k: r[k] for k in ("tests", "passed", "failed", "skipped", "xfailed")} | {
        "minutes": round(r["seconds"] / 60, 1)}
    c = ci_results.coverage(art)
    if c:
        cov = c
        entry["coverage"] = {k: c[k] for k in ("lines", "lines_hit", "functions", "functions_hit",
                                               "files", "files_unreached", "areas")}
history.append(entry)
os.makedirs(site, exist_ok=True)
with open(os.path.join(site, "history.json"), "w") as f:
    json.dump(history, f, separators=(",", ":"))

e = html.escape
covered = [h for h in history if h.get("coverage")]
prev_cov = covered[-2]["coverage"] if cov and len(covered) > 1 else None


def pct(hit, total):
    return 100 * hit / total if total else 0.0


def delta(now, before, unit="%"):
    if before is None:
        return ""
    d = now - before
    if abs(d) < 0.05:
        return '<span class="delta">no change</span>'
    cls = "up" if d > 0 else "down"
    return f'<span class="delta {cls}">{d:+.1f}{unit}</span>'


def latest(flavor):
    """The newest history entry that ran `flavor`."""
    for h in reversed(history):
        if flavor in h.get("flavors", {}):
            return h
    return None


def chart(series, lo, hi, unit):
    """A line chart: series is [(label, css var, [value or None per entry])]."""
    W, H, L, R, T, B = 640, 200, 44, 12, 12, 26
    n = max(len(s[2]) for s in series)

    def x(i):
        return L + (W - L - R) * (i / (n - 1) if n > 1 else 0.5)

    def y(v):
        return T + (H - T - B) * (1 - (v - lo) / (hi - lo or 1))
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" class="chart">']
    for k in range(5):
        v = lo + (hi - lo) * k / 4
        out.append(f'<line x1="{L}" x2="{W - R}" y1="{y(v):.1f}" y2="{y(v):.1f}" class="grid"/>'
                   f'<text x="{L - 6}" y="{y(v) + 4:.1f}" class="axis" text-anchor="end">'
                   f'{v:.0f}{unit}</text>')
    dates = [h["date"][:10] for h in history]
    for i in sorted({0, n - 1}):
        out.append(f'<text x="{x(i):.1f}" y="{H - 6}" class="axis" '
                   f'text-anchor="{"start" if i == 0 and n > 1 else "end" if n > 1 else "middle"}">'
                   f'{dates[i]}</text>')
    for label, color, vals in series:
        pts = [(x(i), y(v)) for i, v in enumerate(vals) if v is not None]
        if len(pts) > 1:
            out.append(f'<polyline fill="none" stroke="var({color})" stroke-width="2" points="'
                       + " ".join(f"{a:.1f},{b:.1f}" for a, b in pts) + '"/>')
        for a, b in pts[-1:]:
            out.append(f'<circle cx="{a:.1f}" cy="{b:.1f}" r="3.5" fill="var({color})"/>')
    out.append("</svg>")
    legend = "".join(f'<span><i style="background:var({c})"></i>{e(l)}</span>'
                     for l, c, _ in series)
    return "".join(out) + f'<div class="legend">{legend}</div>'


cards = []
for fl in FLAVORS:
    h = latest(fl)
    if not h:
        continue
    r = h["flavors"][fl]
    when = h["date"][:10]
    if r is None:
        cards.append(f'<div class="card bad"><h3>{LABEL[fl]}</h3><div class="big">no results</div>'
                     f'<p>fpp did not build, or the run stopped early · {when}</p></div>')
        continue
    ok = r["failed"] == 0
    cards.append(f'<div class="card {"good" if ok else "bad"}"><h3>{LABEL[fl]}</h3>'
                 f'<div class="big">{r["passed"]}<small> / {r["tests"]} passed</small></div>'
                 f'<p>{r["failed"]} failed · {r["skipped"]} skipped · {r["xfailed"]} expected '
                 f'failures · {r["minutes"]:.0f} min · {when}</p></div>')
if covered:
    c = covered[-1]["coverage"]
    lp, fp = pct(c["lines_hit"], c["lines"]), pct(c["functions_hit"], c["functions"])
    cards.append(f'<div class="card"><h3>line coverage</h3><div class="big">{lp:.1f}%</div>'
                 f'<p>{c["lines_hit"]:,} of {c["lines"]:,} lines '
                 f'{delta(lp, pct(prev_cov["lines_hit"], prev_cov["lines"]) if prev_cov else None)}</p></div>')
    cards.append(f'<div class="card"><h3>function coverage</h3><div class="big">{fp:.1f}%</div>'
                 f'<p>{c["functions_hit"]:,} of {c["functions"]:,} functions · '
                 f'{c["files_unreached"]} of {c["files"]} files never reached '
                 f'{delta(fp, pct(prev_cov["functions_hit"], prev_cov["functions"]) if prev_cov else None)}</p></div>')

charts = []
if covered:
    vals = [pct(h["coverage"]["lines_hit"], h["coverage"]["lines"]) if h.get("coverage") else None
            for h in history]
    fvals = [pct(h["coverage"]["functions_hit"], h["coverage"]["functions"]) if h.get("coverage")
             else None for h in history]
    top = min(100, max(v for v in vals + fvals if v is not None) + 10)
    charts.append("<section><h2>Coverage over time</h2>" + chart(
        [("lines", "--c1", vals), ("functions", "--c2", fvals)], 0, top, "%") + "</section>")
# The scenario flavors only: the web suite's few dozen tests would sit flat on
# the floor of an axis sized for the scenarios. Its count is in its card and in
# the table of runs.
SCENARIO_FLAVORS = [fl for fl in FLAVORS if fl != "web"]
counts = {fl: [(h["flavors"].get(fl) or {}).get("tests") for h in history] for fl in SCENARIO_FLAVORS}
allc = [v for vs in counts.values() for v in vs if v]
if allc:
    charts.append("<section><h2>Scenarios per run</h2>" + chart(
        [(LABEL[fl], f"--c{i + 1}", counts[fl]) for i, fl in enumerate(SCENARIO_FLAVORS) if any(counts[fl])],
        0, max(allc) * 1.15, "") + "</section>")

tables = []
if covered:
    c = covered[-1]["coverage"]
    before = (prev_cov or {}).get("areas", {})
    rows = sorted(c["areas"].items(), key=lambda kv: kv[1][1] - kv[1][0])
    tr = []
    for d, (n, h, fn, fh, files) in rows:
        p = pct(h, n)
        b = before.get(d)
        tr.append(f'<tr><td><code>{e(d)}</code></td><td>{files}</td><td>{n:,}</td>'
                  f'<td><div class="bar"><span style="width:{p:.1f}%"></span></div>{p:.1f}% '
                  f'{delta(p, pct(b[1], b[0]) if b else None)}</td>'
                  f'<td>{pct(fh, fn):.1f}%</td><td>{n - h:,}</td></tr>')
    tables.append(
        '<section><h2>Coverage by source directory</h2>'
        '<p class="note">FPP\'s own code under <code>src/</code> (fppd, its plugins and tools), not the submodules. Most lines '
        'no scenario reaches first: these are the places a new scenario adds the most. '
        'Some code can\'t run in the Docker suite at all (cape GPIO, PRU, framebuffers, '
        'serial ports), so no directory is expected to reach 100%.</p>'
        '<div class="scroll"><table><thead><tr><th>directory</th><th>files</th><th>lines</th>'
        '<th>line coverage</th><th>functions</th><th>lines not reached</th></tr></thead><tbody>'
        + "".join(tr) + "</tbody></table></div></section>")
    if cov:
        files = sorted(cov["by_file"].items(), key=lambda kv: kv[1][1] - kv[1][0])[:40]
        tr = [f'<tr><td><code>{e(name)}</code></td><td>{n:,}</td>'
              f'<td><div class="bar"><span style="width:{pct(h, n):.1f}%"></span></div>'
              f'{pct(h, n):.1f}%</td><td>{pct(fh, fn):.1f}%</td><td>{n - h:,}</td></tr>'
              for name, (n, h, fn, fh) in files]
        tables.append(
            '<section><h2>The 40 files with the most unreached lines</h2>'
            '<div class="scroll"><table><thead><tr><th>file</th><th>lines</th>'
            '<th>line coverage</th><th>functions</th><th>lines not reached</th></tr></thead><tbody>'
            + "".join(tr) + "</tbody></table></div></section>")

runs = []
for h in reversed(history[-30:]):
    cells = []
    for fl in FLAVORS:
        if fl not in h["flavors"]:
            cells.append("<td></td>")
        elif h["flavors"][fl] is None:
            cells.append('<td class="bad">no results</td>')
        else:
            r = h["flavors"][fl]
            cells.append(f'<td class="{"good" if not r["failed"] else "bad"}">'
                         f'{r["passed"]}/{r["tests"]}'
                         + (f' · {r["failed"]} failed' if r["failed"] else "") + "</td>")
    c = h.get("coverage")
    sha = h.get("sha", "")
    ver = f'<a href="{FPP_COMMIT}{e(sha)}">{e(h.get("fpp", "?"))}</a>' if sha else e(h.get("fpp", "?"))
    cv = f"{pct(c['lines_hit'], c['lines']):.1f}%" if c else ""
    runs.append(f'<tr><td><a href="{e(h["run"])}">{e(h["date"].replace("T", " "))}</a></td>'
                f'<td>{ver}</td>{"".join(cells)}<td>{cv}</td></tr>')

last = history[-1]
cov_link = ('<a class="button" href="coverage/html/index.html">Line-by-line coverage report</a> '
            '<a class="button" href="coverage/functions.csv">Every function and its call count (CSV)</a>'
            if cov else "")

page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FPP Tests</title>
<style>
:root {{ --bg:#fbfbfa; --fg:#1d1f21; --muted:#5f6670; --line:#e2e4e8; --card:#fff;
  --good:#1a7f37; --bad:#c62828; --c1:#2563eb; --c2:#d97706; --c3:#7c3aed; --bar:#dbe4f5; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#111315; --fg:#e7e9ec; --muted:#9aa3ad;
  --line:#2b2f34; --card:#1a1d20; --good:#4ac26b; --bad:#ff6b6b; --c1:#6ea2ff; --c2:#f5a524;
  --c3:#b392ff; --bar:#22324d; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }}
main {{ max-width:1100px; margin:0 auto; padding:24px 16px 64px; }}
h1 {{ font-size:1.6rem; margin:0 0 4px; }} h2 {{ font-size:1.15rem; margin:0 0 10px; }}
h3 {{ font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0; }}
a {{ color:var(--c1); }} code {{ font-size:.88em; }}
.sub, .note {{ color:var(--muted); margin:0 0 16px; }}
.cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:20px 0; }}
.card {{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }}
.card.good {{ border-top:3px solid var(--good); }} .card.bad {{ border-top:3px solid var(--bad); }}
.card p {{ margin:4px 0 0; color:var(--muted); font-size:.85rem; }}
.big {{ font-size:1.8rem; font-weight:650; }} .big small {{ font-size:.9rem; font-weight:400; color:var(--muted); }}
section {{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin:16px 0; }}
.charts {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:0 16px; }}
.chart {{ width:100%; height:auto; }} .grid {{ stroke:var(--line); }}
.axis {{ fill:var(--muted); font-size:11px; }}
.legend {{ display:flex; gap:14px; font-size:.85rem; color:var(--muted); }}
.legend i {{ display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; }}
.scroll {{ overflow-x:auto; }}
table {{ border-collapse:collapse; width:100%; font-size:.88rem; }}
th, td {{ text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }}
th {{ color:var(--muted); font-weight:600; }}
td.good {{ color:var(--good); }} td.bad {{ color:var(--bad); }}
.bar {{ display:inline-block; width:80px; height:8px; background:var(--bar); border-radius:4px;
  margin-right:8px; vertical-align:middle; overflow:hidden; }}
.bar span {{ display:block; height:100%; background:var(--c1); }}
.delta {{ font-size:.8rem; color:var(--muted); margin-left:4px; }}
.delta.up {{ color:var(--good); }} .delta.down {{ color:var(--bad); }}
.button {{ display:inline-block; padding:8px 14px; border:1px solid var(--line); border-radius:8px;
  background:var(--card); text-decoration:none; margin:0 8px 8px 0; }}
</style></head><body><main>
<h1>FPP tests</h1>
<p class="sub">Nightly runs of <a href="https://github.com/FalconChristmas/fpp-tests">fpp-tests</a>
against fpp master: every scenario under ASan and TSan, once more in a coverage build to see
what FPP code the scenarios reach, and the web UI suite in a browser against the pages served
as on a player, with the ASan fppd behind them. Last run {e(last["date"].replace("T", " "))},
fpp {e(last.get("fpp", "?"))} (<a href="{e(last["run"])}">run log</a>).</p>
<div class="cards">{"".join(cards)}</div>
<p>{cov_link}</p>
<p class="note">Want to help? Pick a directory or file below with many unreached lines, open it in the
coverage report to see which paths no scenario takes, and add a scenario that drives them
(<a href="{README}">how to write one</a>).</p>
<div class="charts">{"".join(charts)}</div>
{"".join(tables)}
<section><h2>Recent runs</h2><div class="scroll"><table><thead><tr><th>run</th><th>fpp</th>
{"".join(f"<th>{LABEL[fl]}</th>" for fl in FLAVORS)}<th>line coverage</th></tr></thead>
<tbody>{"".join(runs)}</tbody></table></div>
<p class="note">All runs, as JSON: <a href="history.json">history.json</a></p></section>
</main></body></html>
"""
with open(os.path.join(site, "index.html"), "w") as f:
    f.write(page)
