"""Which scenario files shard INDEX of COUNT runs, for the CI workflow and
run.sh -j.

    python3 scripts/shard.py [--flavor F] INDEX COUNT [ITEM...]    (INDEX from 1)

Prints the files, one per line. With ITEMs (scenario files, directories of
them, or pytest node ids such as scenarios/test_x.py::test_y) it splits those
instead of every scenario file; a node id weighs what its file does, and a
shard with nothing in it prints nothing. Every item lands in exactly one shard, and
the shards are balanced by how long each file took (shard-weights-F.json, the
seconds per file of a whole run of flavor F, asan's if F is not given or has
none; a file not listed counts as the median), the longest first onto
whichever shard has the least so far. The split depends
only on the files and the weights, so every job of a run computes the same
one.

Each flavor has its own weights: a file can cost minutes under one and
nothing under another (the AES67 and crash-handler scenarios skip under TSan
but take ~15 minutes between them under ASan), so one flavor's weights pile
the other's slow files onto one shard.

Refresh a flavor's weights from a whole run's junit.xml when its shards drift
apart: python3 scripts/shard.py --weights artifacts/junit.xml --flavor F
(CI's results-F artifact holds that run's merged junit.xml.)
"""

import collections
import glob
import json
import os
import statistics
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))


def weights_path(flavor):
    return os.path.join(HERE, f"shard-weights-{flavor}.json")


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


def shards(count, items=None, flavor="asan"):
    # debug and optimized have no runs of their own to weigh; they skip
    # what ASan does, not what TSan does.
    path = weights_path(flavor)
    if not os.path.exists(path):
        path = weights_path("asan")
    with open(path) as f:
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


def take_flavor(args):
    if "--flavor" in args:
        i = args.index("--flavor")
        flavor = args[i + 1]
        del args[i:i + 2]
        return flavor
    return "asan"


if __name__ == "__main__":
    args = sys.argv[1:]
    flavor = take_flavor(args)
    if len(args) == 2 and args[0] == "--weights":
        with open(weights_path(flavor), "w") as f:
            json.dump(weights_from_junit(args[1]), f, indent=1)
            f.write("\n")
        sys.exit(0)
    index, count = int(args[0]), int(args[1])
    if not 1 <= index <= count:
        sys.exit(f"shard {index} of {count}?")
    files = shards(count, args[2:], flavor)[index - 1]
    if files:
        print("\n".join(files))
