"""Bring a coverage ledger (ledger/*.tsv) up to date with fpp's history.

    python3 scripts/ledger-update.py [--fpp ../fpp] [--since 8.5.1] [--to origin/master]
        [--merge OLD.tsv ...] LEDGER.tsv

Every non-merge fpp commit in since..to gets a row. A row someone has filled
in is kept as it is; only rows whose note starts with "auto:" are rewritten,
so the script can be run again whenever commits land. --merge takes rows from
another ledger as filled-in rows (their commits must be in the range).

What it fills in by itself:
  named       a scenario or web test names the commit, in its text or in the
              fpp-tests commit that added it (proof "unreviewed": nobody has
              checked that the test fails without the commit)
  untestable  the commit changes no runtime file: docs, help text, CI, dev
              dependencies, an empty version commit
  todo        everything else

and on every row, the release the commit first shipped in (a cherry-pick onto
a release branch counts), an area, and where a test would most likely run.
"""

import argparse
import ast
import collections
import os
import re
import subprocess
import sys

COLUMNS = ["commit", "outcome", "test", "proof", "note", "subject", "release", "area", "where"]
ABBREV = 9

# A commit touching only these changes nothing a test could see.
NONRUNTIME = re.compile(r"""(
    \.md$ | ^docs/ | ^\.github/ | ^\.claude/ | ^plans/ | ^rpi-imager/ | ^LICENSE |
    ^www/help/ | ^tests/ | ^poster_prompt | ^release_notes | ^\.gitignore$ |
    ^www/api/openapi\.json$ | ^\.clang-format$ | ^\.prettierrc
)""", re.X)

# Where a test for a change to a path would run, most demanding first.
WHERE = [
    ("device:bb", re.compile(r"""(
        ^src/non-gpl/(BBB48String|BBShiftPanel|BBShiftString|FalconV5Support)/ | ^src/pru/ |
        ^src/channeloutput/BBB | ^src/util/BBB | ^capes/(bbb|pb)/ | ^capes/drivers/bbb/ |
        ^src/makefiles/platform/bb | ^bin\.bbb/
    )""", re.X)),
    ("device:pi", re.compile(r"""(
        ^src/non-gpl/DPIPixels/ | ^src/channeloutput/(RPi|spixels|rpi) | ^capes/pi/ |
        ^capes/drivers/pi/ | ^src/makefiles/platform/pi | ^bin\.pi/
    )""", re.X)),
    ("device:mac", re.compile(r"MacOS|^src/makefiles/platform/osx|CoreAudio|^SD/FPP_Install_Mac")),
    ("device", re.compile(r"""(
        ^src/non-gpl/CapeUtils/ | ^src/oled/ | ^src/sensors/ | ^src/framebuffer/ |
        ^src/channeloutput/(GPIO|GPIO595|MCP23017|PCA9685|PCF8574|MAX7219|ILI9488|SPI|Generic(Serial|SPI)|
            USB|LOR|Renard|DMX|FBMatrix|Matrix|RGBMatrix|ColorLight|Linsn|ModelPixelStrings|spi|serial|UDMX|FPD) |
        ^src/(gpio|i2c|spi|serial|GPIO|I2C|SPI|Serial|fpprtc|capeutils|util/(GPIO|I2C|SPI|Serial|Pin|Ws2811|.*Pin))|
        ^src/boot/FPPRTC | ^src/.*(KMS|DRM|Drm|Kms) | ^src/channeltester/PixelCount | ^capes/ | ^src/fppcapedetect
    )""", re.X)),
    ("os-image", re.compile(r"^SD/|^etc/systemd/|^etc/(modprobe|udev|sysctl|network|NetworkManager|hostapd|dnsmasq|wpa)|^Docker/|^dockerBuild")),
    ("docker", re.compile(r"^src/|^scripts/|^upgrade/|^etc/|^external/|^plugins/|^media/")),
    ("web", re.compile(r"^www/")),
]


def git(fpp, *args):
    return subprocess.run(["git", "-C", fpp, *args], check=True, capture_output=True, text=True).stdout


def commits(fpp, since, to):
    """[(short hash, full hash, subject, [files])], newest first."""
    out = git(fpp, "log", "--no-merges", f"--abbrev={ABBREV}", "--format=\x01%h\t%H\t%s", "--name-only", f"{since}..{to}")
    result = []
    for chunk in out.split("\x01")[1:]:
        head, *files = chunk.split("\n")
        short, full, subject = head.split("\t", 2)
        result.append((short, full, subject, [f for f in files if f]))
    return result


def patch_ids(fpp, revs):
    if not revs:
        return {}
    log = subprocess.run(["git", "-C", fpp, "log", "-p", "--no-merges", "--no-walk", "--stdin"],
                         input="\n".join(revs), check=True, capture_output=True, text=True).stdout
    ids = subprocess.run(["git", "-C", fpp, "patch-id", "--stable"], input=log,
                         check=True, capture_output=True, text=True).stdout
    return {c: p for p, c in (line.split() for line in ids.splitlines())}


def releases(fpp, since, to, rows):
    """The first release tag each commit shipped in, counting cherry-picks."""
    tags = [t for t in git(fpp, "tag", "-l").split() if re.fullmatch(r"\d+\.\d+(\.\d+)?", t)]
    key = lambda t: tuple(int(x) for x in t.split("."))
    # since's own release line (8.5 and 8.5.1 for since 8.5.1) can have
    # shipped cherry-picks of the range's commits before since itself.
    tags = sorted((t for t in tags if key(t) > key(since) or key(t)[:2] == key(since)[:2]), key=key)
    full = {r[1] for r in rows}
    first = {}
    pids = None
    for t in tags:
        base = since if key(t) > key(since) else git(fpp, "merge-base", t, to).strip()
        members = set(git(fpp, "rev-list", "--no-merges", f"{base}..{t}").split())
        for c in members & full:
            first.setdefault(c, t)
        # A release branch's own commits: cherry-picks of the range's commits.
        picked = members - full
        if picked:
            if pids is None:
                pids = patch_ids(fpp, sorted(full))
            branch = set(patch_ids(fpp, sorted(picked)).values())
            for c, p in pids.items():
                if p in branch:
                    first.setdefault(c, t)
    return {c: first.get(c, "unreleased") for c in full}


def test_refs(tests_dir, rows):
    """{full hash: ["file::test", ...]} for the tests that name a commit."""
    by_prefix = collections.defaultdict(list)
    for r in rows:
        by_prefix[r[1][:7]].append(r[1])

    def resolve(h):
        hits = [c for c in by_prefix.get(h[:7], []) if c.startswith(h)]
        return hits[0] if len(hits) == 1 else None

    hexre = re.compile(r"\b[0-9a-f]{7,40}\b")
    found = collections.defaultdict(list)

    def add(c, ref):
        if ref not in found[c]:
            found[c].append(ref)

    files = subprocess.run(["git", "-C", tests_dir, "ls-files", "scenarios", "web/tests"],
                           check=True, capture_output=True, text=True).stdout.split()
    is_test = lambda f: re.search(r"(^|/)test_\w+\.py$|\.spec\.ts$", f)
    for f in files:
        if not is_test(f):
            continue
        lines = open(os.path.join(tests_dir, f), errors="replace").read().split("\n")
        for i, line in enumerate(lines):
            for h in hexre.findall(line):
                c = resolve(h)
                if c:
                    add(c, f + test_name(f, lines, i))
    # A test whose fpp-tests commit names the fix, and the test does not. Only
    # a commit about one or two fixes: a bulk commit names everything.
    log = subprocess.run(["git", "-C", tests_dir, "log", "--format=\x01%B\x02", "--name-only", "--", "scenarios", "web/tests"],
                         check=True, capture_output=True, text=True).stdout
    for chunk in log.split("\x01")[1:]:
        msg, names = chunk.split("\x02", 1)
        names = [n for n in names.split() if is_test(n) and os.path.exists(os.path.join(tests_dir, n))]
        fixes = {c for c in map(resolve, set(hexre.findall(msg))) if c}
        if len(fixes) > 2 or len(names) > 3:
            continue
        for c in fixes:
            for n in names:
                if not any(x.startswith(n) for x in found[c]):
                    add(c, n)
    return found


_py_tests = {}


def py_tests(f, lines):
    """[(first, last, name)] 0-based line spans of a module's top-level
    functions, decorators included, from its syntax tree; and of each
    module-level table that exactly one test reads, under that test's name."""
    if f not in _py_tests:
        try:
            tree = ast.parse("\n".join(lines))
        except SyntaxError:
            tree = ast.Module(body=[], type_ignores=[])
        funcs = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        spans = [(min([n.lineno] + [d.lineno for d in n.decorator_list]) - 1, n.end_lineno - 1, n.name)
                 for n in funcs]
        for n in tree.body:
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                users = [fn.name for fn in funcs if fn.name.startswith("test") and any(
                    isinstance(x, ast.Name) and x.id == n.targets[0].id for x in ast.walk(fn))]
                if len(users) == 1:
                    spans.append((n.lineno - 1, n.end_lineno - 1, users[0]))
        _py_tests[f] = spans
    return _py_tests[f]


def test_name(f, lines, i):
    """'::name' of the test a line at index i belongs to, or '' for the file."""
    if f.endswith(".py"):
        # A hash in a test's decorators (a parametrize list) is that test's,
        # as is one in a module-level table only that test reads; one in a
        # helper, or a table more tests share, is the file's. A comment block
        # just above a test or table goes with it.
        while lines[i].strip().startswith("#") and i + 1 < len(lines) and \
                not any(a <= i <= b for a, b, _ in py_tests(f, lines)):
            i += 1
        for a, b, name in py_tests(f, lines):
            if a <= i <= b:
                return "::" + name if name.startswith("test") else ""
        return ""
    title = re.compile(r"""\btest(?:\.(?:describe|skip|fixme|only))?\(\s*(['"`])(.+?)\1""")
    # The comment above a test names its commit, so look ahead first.
    for j in list(range(i, min(i + 40, len(lines)))) + list(range(i - 1, -1, -1)):
        m = title.search(lines[j])
        if m:
            name = m.group(2)
            return "::" + (name[:60] + "…" if len(name) > 60 else name)
    return ""


def area(subject, files):
    m = re.match(r"\w+\(([^)]+)\)!?:", subject)
    if m:
        return m.group(1).strip().lower()
    for f in files:
        parts = f.split("/")
        if parts[0] in ("src", "www", "scripts", "SD", "etc", "capes") and len(parts) > 2:
            return parts[1]
    return files[0].split("/")[0] if files else ""


def where(files):
    """Where a test could run, for each kind of file changed, most demanding
    first: "device:bb,docker" for a change to fppd and to a BBB output."""
    found = []
    for f in files:
        if NONRUNTIME.search(f):
            continue
        name = next((n for n, pat in WHERE if pat.search(f)),
                    "build" if "Makefile" in f or "makefiles" in f else "docker")
        if name not in found:
            found.append(name)
    order = [n for n, _ in WHERE] + ["build"]
    return ",".join(sorted(found, key=order.index)) or "none"


def auto_row(short, subject, files, named):
    if named:
        return [short, "named", "; ".join(named), "unreviewed",
                "auto: a test names this commit; check it fails without it", subject]
    if where(files) == "none":
        if not files:
            why = "an empty commit (a version or release marker)"
        else:
            why = "changes no runtime file (" + ", ".join(sorted({f.split('/')[0] for f in files}))[:60] + ")"
        return [short, "untestable", "", "none", "auto: " + why, subject]
    if re.search(r"\bbump\b.*\bfrom\b.*\bto\b", subject) and "deps-dev" in subject:
        return [short, "untestable", "", "none", "auto: a development dependency of the www build", subject]
    return [short, "todo", "", "none", "auto: not examined yet", subject]


def read(path):
    if not os.path.exists(path):
        return {}
    rows = {}
    with open(path) as f:
        header = f.readline().rstrip("\n").split("\t")
        for line in f:
            vals = line.rstrip("\n").split("\t")
            row = dict(zip(header, vals + [""] * (len(header) - len(vals))))
            rows[row["commit"]] = [row.get(c, "") for c in COLUMNS]
    return rows


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--fpp", default=os.path.join(here, "..", "fpp"))
    ap.add_argument("--since", default="8.5.1")
    ap.add_argument("--to", default="origin/master")
    ap.add_argument("--merge", action="append", default=[])
    ap.add_argument("ledger")
    a = ap.parse_args()

    rows = commits(a.fpp, a.since, a.to)
    if not rows:
        sys.exit(f"no commits in {a.since}..{a.to}")
    rel = releases(a.fpp, a.since, a.to, rows)
    named = test_refs(here, rows)

    old = {}
    for m in a.merge:
        old.update(read(m))
    old.update(read(a.ledger))
    in_range = {r[0] for r in rows}
    missing = sorted(set(old) - in_range)
    if missing:
        sys.exit(f"{len(missing)} ledger rows name commits outside {a.since}..{a.to}: {' '.join(missing[:10])}")

    counts = collections.Counter()
    with open(a.ledger + ".new", "w") as out:
        out.write("\t".join(COLUMNS) + "\n")
        for short, full, subject, files in rows:
            kept = old.get(short)
            if kept and not kept[4].startswith("auto:"):
                row = kept[:6]
            else:
                row = auto_row(short, subject, files, named.get(full))
            row += [rel[full], (kept[7] if kept and kept[7] else area(subject, files)),
                    (kept[8] if kept and kept[8] else where(files))]
            counts[row[1]] += 1
            out.write("\t".join(v.replace("\t", " ").replace("\n", " ") for v in row) + "\n")
    os.replace(a.ledger + ".new", a.ledger)
    print(f"{len(rows)} commits: " + ", ".join(f"{n} {k}" for k, n in counts.most_common()))


if __name__ == "__main__":
    main()
