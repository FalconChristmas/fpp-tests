"""The scenarios a device run adds to the Docker ones, for the Device workflow.

    python3 scripts/device-tests.py JUNIT.xml

Prints the pytest node id of every test the Docker run that wrote JUNIT.xml
skipped, one per line. A scenario that needs hardware -- a Pi's config.txt
or header pins, a BeagleBone, a real sound card, a display -- skips itself
in Docker, so the skipped ones are exactly what only a device can run, and
the list follows the suite as hardware scenarios are added. Exits non-zero
if the junit names no test at all (the Docker run never got to pytest).
"""

import sys
import xml.etree.ElementTree as ET

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
print("\n".join(sorted(set(ids))))
