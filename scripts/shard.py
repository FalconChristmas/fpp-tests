"""Which scenario files shard INDEX of COUNT runs, for the CI workflow and
run.sh -j.

    python3 scripts/shard.py INDEX COUNT [ITEM...]    (INDEX from 1)

Prints the files, one per line. With ITEMs (scenario files, directories of
them, or pytest node ids such as scenarios/test_x.py::test_y) it splits those
instead of every scenario file; a node id weighs what its file does, and a
shard with nothing in it prints nothing. Every item lands in exactly one shard, and
the shards are balanced by how long each file took (shard-weights.json, the
seconds per file of a whole run; a file not listed counts as the median), the
longest first onto whichever shard has the least so far. The split depends
only on the files and the weights, so every job of a run computes the same
one.

Refresh shard-weights.json from a whole run's junit.xml when the shards drift
apart: python3 scripts/shard.py --weights artifacts/junit.xml
"""

import collections
import glob
import json
import os
import statistics
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = os.path.join(HERE, "shard-weights.json")


def weights_from_junit(junit):
    seconds = collections.Counter()
    for c in ET.parse(junit).getroot().iter("testcase"):
        cls = c.get("classname", "")
        if cls.startswith("scenarios."):
            seconds["scenarios/" + cls.split(".")[1] + ".py"] += float(c.get("time") or 0)
    return {f: round(s, 1) for f, s in sorted(seconds.items())}


def expand(items):
    """ITEMs as files and node ids, relative to the fpp-tests root."""
    root = os.path.dirname(HERE)
    out = set()
    for item in items or ["scenarios"]:
        path = os.path.normpath(item.split("::")[0])
        if os.path.isdir(os.path.join(root, path)):
            out.update(os.path.relpath(f, root) for f in glob.glob(os.path.join(root, path, "**", "test_*.py"), recursive=True))
        else:
            out.add(path + item[len(item.split("::")[0]):])
    return sorted(out)


def shards(count, items=None):
    with open(WEIGHTS) as f:
        known = json.load(f)
    default = statistics.median(known.values()) if known else 1.0

    def weight(item):
        return known.get(item.split("::")[0], default)

    load = [0.0] * count
    out = [[] for _ in range(count)]
    for f in sorted(expand(items), key=lambda f: (-weight(f), f)):
        i = load.index(min(load))
        load[i] += weight(f)
        out[i].append(f)
    return [sorted(s) for s in out]


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--weights":
        with open(WEIGHTS, "w") as f:
            json.dump(weights_from_junit(sys.argv[2]), f, indent=1)
            f.write("\n")
        sys.exit(0)
    index, count = int(sys.argv[1]), int(sys.argv[2])
    if not 1 <= index <= count:
        sys.exit(f"shard {index} of {count}?")
    files = shards(count, sys.argv[3:])[index - 1]
    if files:
        print("\n".join(files))
