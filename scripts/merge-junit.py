"""Merge the junit.xml of a flavor's shards into one, for the CI workflow.

    python3 scripts/merge-junit.py OUT.xml SHARD.xml...

Each shard's <testsuite> goes under one <testsuites>, which is all
ci_results.py reads. A shard with no junit.xml (pytest never finished: a
build failure, a timeout) is reported on stderr and left out; the exit status
is then non-zero, so the merged result cannot pass for a whole run.
"""

import os
import sys
import xml.etree.ElementTree as ET

out, shards = sys.argv[1], sys.argv[2:]
root = ET.Element("testsuites")
missing = []
for path in shards:
    if not os.path.exists(path):
        missing.append(path)
        continue
    r = ET.parse(path).getroot()
    for suite in ([r] if r.tag == "testsuite" else r.findall("testsuite")):
        root.append(suite)
ET.ElementTree(root).write(out, encoding="utf-8", xml_declaration=True)
for path in missing:
    print(f"no results from {path}: that shard did not finish", file=sys.stderr)
sys.exit(1 if missing else 0)
