#!/usr/bin/env python3
"""The job summary for a CI run, in Markdown, on stdout.

    scripts/ci-summary.py ARTIFACTS [COVERAGE_URL]

The test counts, the failures and the slowest scenarios from
ARTIFACTS/junit.xml, and for a coverage build the totals, each directory and
the biggest gaps (ARTIFACTS/coverage/summary.md). See ci_results.py.
"""

import os
import sys

import ci_results

art = sys.argv[1]
cov_url = sys.argv[2] if len(sys.argv) > 2 else ""
m = ci_results.meta(art)
out = [f"## {m.get('flavor', '?')}: fpp {m.get('version', '?')}", ""]

r = ci_results.tests(art)
if r is None:
    out.append("No test results: fpp did not build, or the run stopped before pytest finished.")
else:
    out.append(f"**{r['tests']} tests**: {r['passed']} passed, {r['failed']} failed, "
               f"{r['skipped']} skipped, {r['xfailed']} expected failures · "
               f"{r['seconds'] / 60:.0f} min of scenarios")
    if r["failures"]:
        out += ["", "| scenario | | first line |", "|---|---|---|"]
        for name, kind, msg in r["failures"]:
            msg = msg.replace("|", "\\|")
            out.append(f"| `{name}` | {kind} | {msg} |")
    out += ["", "<details><summary>The 15 slowest scenarios</summary>", "",
            "| scenario | seconds |", "|---|--:|"]
    for t, name in r["slowest"][:15]:
        out.append(f"| `{name}` | {t:.0f} |")
    out += ["", "</details>"]

cov = os.path.join(art, "coverage", "summary.md")
if os.path.exists(cov):
    out += ["", "### Coverage of FPP's own code (`src/`, not the submodules)", ""]
    with open(cov) as f:
        out.append(f.read().rstrip())
    if cov_url:
        out += ["", f"Per-line detail: download [the coverage report]({cov_url}) and open "
                "`html/index.html`. `functions.csv` lists every function with its call count."]

print("\n".join(out))
