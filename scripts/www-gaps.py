#!/usr/bin/env python3
"""Keep ledger/www-gaps.tsv, the web UI's coverage gaps, up to date.

    python3 scripts/www-gaps.py --tree ../fpp RAW [RAW...]
    python3 scripts/www-gaps.py --tree ../fpp --nightly

Each RAW is a run's coverage/www/raw (run-web.sh --www-coverage), or one of
the nightly's www-coverage-raw-N artifacts; several are added together, as
www-coverage-report.py does. --nightly downloads the last scheduled run's
shards with gh. TREE is the fpp checkout the run served: check it out at the
run's commit, or line numbers drift.

One row per function of FPP's PHP and JS under www/ and scripts/ that has a
line no test ran, and one per page for the script inside it ("(inline
script)", counted by line text as the report does). A line belongs to the
nearest named function above it, until a closing brace in column 0 ends that
function; anything else is "(top level)".

| column     | meaning |
|------------|---------|
| file       | path in the fpp tree |
| function   | the function, "(top level)" or "(inline script)" |
| line       | the line the function starts on (0 for inline scripts) |
| unreached  | its executable lines no test ran, in the last refresh |
| lines      | its executable lines |
| status     | `todo`, `test` (a test now reaches what is worth reaching), `untestable` (with the reason), `skip` (not worth a test, with the reason); and, set by the script, `covered` (nothing unreached any more) and `gone` (no longer in the tree) |
| test       | the test(s) that reach it, as web/tests/file.spec.ts |
| note       | why, what is left, what a test would need |

Every refresh rewrites line, unreached and lines. A row whose note starts
with "auto:" is the script's: it gets a status of todo, covered or gone from
the counts. Any other row is kept as someone left it, so to take a row, edit
its status, test and note (and drop the "auto:").

Third-party code is left out, as in the report.
"""

import argparse
import csv
import glob
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
COLUMNS = ["file", "function", "line", "unreached", "lines", "status", "test", "note"]
DEFAULT = os.path.join(HERE, "..", "ledger", "www-gaps.tsv")

spec = importlib.util.spec_from_file_location("report", os.path.join(HERE, "www-coverage-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

FUNC = re.compile(r"^\s*(?:(?:public|private|protected|static|async|export)\s+)*function\s*&?\s*(\w+)\s*\(")
JS_ASSIGNED = re.compile(r"^\s*(?:window\.|var\s+|let\s+|const\s+)?(\w+)\s*=\s*(?:async\s+)?function\b")


# What can come before a "/" that starts a regex literal rather than a division.
REGEX_BEFORE = re.compile(r"(^|[(,=:\[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase)\s*$")


def functions(source, php=False):
    """For each 1-based line, the innermost named function it is in and the
    line that function starts on. Braces are counted outside strings and
    comments (and, in PHP, only inside <?php ... ?>); in JS, regex literals are
    skipped. Anything it misreads at worst misnames lines."""
    owner, stack, depth, parens, pending = {}, [], 0, 0, None
    in_php, quote, block = not php, None, False
    lines = source.split("\n")
    for n, text in enumerate(lines, 1):
        m = FUNC.match(text) or JS_ASSIGNED.match(text)
        if m and in_php and not quote and not block:
            pending, parens = (m.group(1), n), 0
        first = stack[-1][:2] if stack else ("(top level)", 0)
        i, L = 0, len(text)
        while i < L:
            c = text[i]
            if not in_php:
                if text.startswith("<?", i):
                    in_php, i = True, i + 2
                    continue
            elif block:
                if text.startswith("*/", i):
                    block, i = False, i + 2
                    continue
            elif quote:
                if c == "\\":
                    i += 1
                elif c == quote:
                    quote = None
            elif php and text.startswith("?>", i):
                in_php, i = False, i + 2
                continue
            elif text.startswith("/*", i):
                block, i = True, i + 2
                continue
            elif text.startswith("//", i) or (php and c == "#"):
                break
            elif c == "/" and not php and REGEX_BEFORE.search(text[:i]):
                # A regex literal: skip to its closing slash.
                i, cls = i + 1, False
                while i < L and (cls or text[i] != "/"):
                    if text[i] == "\\":
                        i += 1
                    elif text[i] == "[":
                        cls = True
                    elif text[i] == "]":
                        cls = False
                    i += 1
            elif c in "'\"`":
                quote = c
            elif c == "(":
                parens += 1
            elif c == ")":
                parens = max(0, parens - 1)
            elif c == "{":
                depth += 1
                # Not a default argument's {}: the body opens outside the
                # parameter list.
                if pending and not parens:
                    stack.append((pending[0], pending[1], depth))
                    pending = None
            elif c == "}":
                if stack and stack[-1][2] == depth:
                    stack.pop()
                depth = max(0, depth - 1)
            i += 1
        if quote in ("'", '"') and not php:
            quote = None
        # A line is the function's if the function was open at its start or
        # opened on it.
        owner[n] = stack[-1][:2] if stack and stack[-1][1] == n else first
    return owner


def vendored(rel):
    if rel.endswith((".js", ".mjs")):
        return bool(report.VENDORED_JS.search(rel)) and rel not in report.KEEP_JS
    return bool(report.VENDORED_PHP.search(rel))


def php_lines(raws):
    executable, hit = {}, {}
    for raw in raws:
        path = os.path.join(raw, "php-lines.json")
        if os.path.exists(path):
            for f, lines in json.load(open(path))["lines"].items():
                executable.setdefault(f, set()).update(lines)
        for path in glob.glob(os.path.join(raw, "php", "*.json")):
            try:
                d = json.load(open(path))
            except ValueError:
                continue
            hit.setdefault(d["file"], set()).update(d["hit"])
    out = {}
    for f in set(executable) | set(hit):
        rel = report.relative(f)
        if rel:
            ran = hit.get(f, set())
            out[rel] = (executable.get(f, set()) | ran, ran)
    return out


def js_lines(tree, raws):
    external, inline, sources = {}, {}, {}
    for raw in raws:
        for path in glob.glob(os.path.join(raw, "js", "*.json")):
            d = json.load(open(path))
            source = sources.get(d["source"])
            if source is None:
                with open(os.path.join(raw, "js-src", d["source"] + ".js"), errors="replace", newline="") as f:
                    source = sources[d["source"]] = f.read()
            url = re.sub(r"^/proxy/[^/]+", "", d["path"])
            if url.endswith((".js", ".mjs")):
                external.setdefault("www" + url, set()).update(n + 1 for n in d["hit"])
            else:
                page = "www" + url + ("index.php" if url.endswith("/") else "")
                if os.path.exists(os.path.join(tree, page)):
                    lines = source.split("\n")
                    code = report.code_lines(source)
                    texts = inline.setdefault(page, (set(), set()))
                    texts[0].update(lines[n].strip() for n in code)
                    texts[1].update(lines[n].strip() for n in d["hit"] if n in code)
    out = {}
    for root, _, files in os.walk(os.path.join(tree, "www")):
        for name in files:
            if name.endswith((".js", ".mjs")):
                rel = os.path.relpath(os.path.join(root, name), tree)
                with open(os.path.join(tree, rel), errors="replace", newline="") as f:
                    code = {n + 1 for n in report.code_lines(f.read())}
                out[rel] = (code, code & external.get(rel, set()))
    return out, inline


def gaps(tree, raws):
    """{(file, function): (line, unreached, lines)} for every function with
    executable lines, reached or not."""
    rows = {}
    php = php_lines(raws)
    js, inline = js_lines(tree, raws)
    for rel, (code, ran) in list(php.items()) + list(js.items()):
        path = os.path.join(tree, rel)
        if vendored(rel) or not os.path.exists(path):
            continue
        with open(path, errors="replace", newline="") as f:
            owner = functions(f.read(), php=not rel.endswith((".js", ".mjs")))
        for n in code:
            name, start = owner.get(n, ("(top level)", 0))
            line, missed, total = rows.get((rel, name), (start, 0, 0))
            rows[(rel, name)] = (min(line, start) if line else start, missed + (n not in ran), total + 1)
    for page, (code, ran) in inline.items():
        rows[(page, "(inline script)")] = (0, len(code - ran), len(code))
    return rows


def nightly(into):
    run = subprocess.run(["gh", "run", "list", "-R", "FalconChristmas/fpp-tests", "--workflow", "Scenarios",
                          "--event", "schedule", "-L", "1", "--json", "databaseId", "--jq", ".[0].databaseId"],
                         check=True, capture_output=True, text=True).stdout.strip()
    subprocess.run(["gh", "run", "download", run, "-R", "FalconChristmas/fpp-tests", "-p", "www-coverage-raw-*",
                    "-D", into], check=True)
    print(f"nightly run {run}", file=sys.stderr)
    return sorted(glob.glob(os.path.join(into, "www-coverage-raw-*")))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tree", required=True, help="the fpp checkout the run served")
    ap.add_argument("--ledger", default=DEFAULT)
    ap.add_argument("--nightly", action="store_true", help="download the last scheduled run's shards")
    ap.add_argument("raws", nargs="*")
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        raws = nightly(tmp) if a.nightly else a.raws
        if not raws:
            sys.exit("give RAW directories or --nightly")
        found = gaps(a.tree, raws)

    old = {}
    if os.path.exists(a.ledger):
        with open(a.ledger, newline="") as f:
            for r in csv.DictReader(f, delimiter="\t"):
                old[(r["file"], r["function"])] = r

    out = []
    for key in set(old) | {k for k, v in found.items() if v[1]}:
        r = old.get(key) or {"file": key[0], "function": key[1], "status": "todo", "test": "", "note": "auto: not examined yet"}
        line, missed, total = found.get(key, (r.get("line", 0), 0, 0))
        r.update(line=line, unreached=missed, lines=total)
        if r["note"].startswith("auto:"):
            if key not in found:
                r.update(status="gone", note="auto: no longer in the tree")
            elif not missed:
                r.update(status="covered", note="auto: every line reached")
            else:
                r.update(status="todo", note="auto: not examined yet")
        out.append(r)
    out.sort(key=lambda r: (r["file"], int(r["line"] or 0), r["function"]))
    with open(a.ledger, "w", newline="") as f:
        w = csv.DictWriter(f, COLUMNS, delimiter="\t", lineterminator="\n", extrasaction="ignore")
        w.writeheader()
        w.writerows(out)
    todo = [r for r in out if r["status"] == "todo"]
    print(f"{len(out)} rows, {len(todo)} todo, {sum(int(r['unreached']) for r in todo)} unreached lines in them",
          file=sys.stderr)


if __name__ == "__main__":
    main()
