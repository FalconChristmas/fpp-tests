"""Reading a run's results, for ci-summary.py and build-site.py.

A run's artifacts directory holds junit.xml (run.sh), meta.json (the CI
workflow: flavor, fpp version and commit) and, for a coverage build,
coverage/totals.json (scripts/coverage-report.sh).
"""

import json
import os
import xml.etree.ElementTree as ET


def tests(art):
    """The run's test counts and failures, or None if pytest never finished:
    {tests, passed, failed, skipped, xfailed, seconds, failures: [(name,
    kind, first line)], slowest: [(seconds, name)]}."""
    junit = os.path.join(art, "junit.xml")
    if not os.path.exists(junit):
        return None
    r = {"tests": 0, "passed": 0, "failed": 0, "skipped": 0, "xfailed": 0, "seconds": 0.0,
         "failures": [], "slowest": []}
    for c in ET.parse(junit).getroot().iter("testcase"):
        name = f"{c.get('classname', '').removeprefix('scenarios.')}::{c.get('name')}"
        t = float(c.get("time") or 0)
        r["tests"] += 1
        r["seconds"] += t
        r["slowest"].append((t, name))
        bad = c.find("failure")
        if bad is None:
            bad = c.find("error")
        skip = c.find("skipped")
        if bad is not None:
            msg = (bad.get("message") or bad.text or "").strip().splitlines()
            r["failed"] += 1
            r["failures"].append((name, bad.tag == "error" and "error" or "failed",
                                  msg[0][:200] if msg else ""))
        elif skip is not None:
            r["xfailed" if skip.get("type") == "pytest.xfail" else "skipped"] += 1
        else:
            r["passed"] += 1
    r["slowest"].sort(reverse=True)
    return r


def coverage(art):
    """coverage/totals.json, or None if this was not a coverage build."""
    p = os.path.join(art, "coverage", "totals.json")
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def meta(art):
    p = os.path.join(art, "meta.json")
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return json.load(f)


def pct(hit, total):
    return f"{100 * hit / total:.1f}%" if total else "-"
