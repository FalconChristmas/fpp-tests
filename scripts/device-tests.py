"""The scenarios a device run adds to the Docker ones, for the Device workflow.

    python3 scripts/device-tests.py JUNIT.xml

Prints the pytest node id of every test the Docker run that wrote JUNIT.xml
skipped, one per line. A scenario that needs hardware -- a Pi's config.txt
or header pins, a BeagleBone, a real sound card, a display -- skips itself
in Docker, so the skipped ones are exactly what only a device can run, and
the list follows the suite as hardware scenarios are added. Exits non-zero
if the junit names no test at all (the Docker run never got to pytest).
"""

import os
import re
import sys
import xml.etree.ElementTree as ET


def defined(node):
    """Whether this checkout still has the test: the junit is the last
    night's run, and a scenario renamed or removed since would make pytest
    refuse the whole device run ("not found")."""
    path, name = node.split("::", 1)
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", path)) as f:
            src = f.read()
    except OSError:
        return False
    return re.search(r"^\s*(?:async\s+)?def " + re.escape(name.split("[", 1)[0]) + r"\(", src, re.M) is not None

root = ET.parse(sys.argv[1]).getroot()
seen = 0
ids = []
for c in root.iter("testcase"):
    seen += 1
    if c.find("skipped") is None:
        continue
    cls = c.get("classname", "")
    if not cls.startswith("scenarios."):
        continue
    ids.append("scenarios/" + cls.split(".")[1] + ".py::" + c.get("name"))
if not seen:
    sys.exit(f"{sys.argv[1]} names no tests: the Docker run did not finish")
gone = sorted({i for i in ids if not defined(i)})
for i in gone:
    print(f"no longer in the suite, not run: {i}", file=sys.stderr)
print("\n".join(sorted(set(ids) - set(gone))))
