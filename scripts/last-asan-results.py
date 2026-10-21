"""Fetch the newest complete ASan junit.xml of the Scenarios workflow, for the
device job.

    GH_TOKEN=... python3 scripts/last-asan-results.py OUT.xml

Looks through the latest scheduled runs, then the latest runs by hand, for a
results-asan artifact whose junit.xml names a whole suite (a cancelled run, or
one dispatched with -k, names too few to say which scenarios Docker skips).
Uses GITHUB_API_URL, GITHUB_REPOSITORY and GITHUB_RUN_ID from the job; skips
the run it is part of.
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

API = os.environ.get("GITHUB_API_URL", "https://api.github.com")
REPO = os.environ["GITHUB_REPOSITORY"]
SELF = os.environ.get("GITHUB_RUN_ID", "")
TOKEN = os.environ["GH_TOKEN"]
WHOLE = 1000  # tests in a run that ran the whole suite


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get(url, raw=False):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}",
                                               "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(req) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        # An artifact's archive redirects to storage that refuses the token.
        if e.code not in (301, 302, 303, 307, 308):
            raise
        with urllib.request.urlopen(e.headers["Location"]) as r:
            data = r.read()
    return data if raw else json.loads(data)


for event in ("schedule", "workflow_dispatch"):
    runs = get(f"{API}/repos/{REPO}/actions/workflows/scenarios.yml/runs"
               f"?event={event}&status=completed&per_page=40")["workflow_runs"]
    for run in runs:
        if str(run["id"]) == SELF:
            continue
        arts = get(f"{API}/repos/{REPO}/actions/runs/{run['id']}/artifacts?name=results-asan")["artifacts"]
        if not arts or arts[0].get("expired"):
            continue
        with zipfile.ZipFile(io.BytesIO(get(arts[0]["archive_download_url"], raw=True))) as z:
            if "junit.xml" not in z.namelist():
                continue
            junit = z.read("junit.xml")
        tests = sum(1 for _ in ET.fromstring(junit).iter("testcase"))
        if tests < WHOLE:
            continue
        with open(sys.argv[1], "wb") as f:
            f.write(junit)
        print(f"ASan results of run {run['id']} ({event}, {tests} tests)")
        sys.exit(0)
sys.exit("no recent Scenarios run has a whole ASan results-asan")
