#!/usr/bin/env python3
"""The report for run-web.sh --www-coverage: which of FPP's own PHP and JS under
www/ the web suite ran.

    www-coverage-report.py TREE OUT RAW [RAW...]

TREE holds fpp's source, each RAW is a run's coverage/www/raw (several for a
sharded run: their counts are added together) and OUT gets:

    summary.txt   per-file line coverage, most unreached lines first
    summary.md    totals and the biggest gaps, in Markdown
    totals.json   the same numbers as data

PHP's lines are what PCOV counts as executable. JS's are lines with code in
them, from V8's coverage of the scripts Chromium loaded. Scripts inside PHP
pages are counted on their own, by the text of each line, as PHP makes their
contents differ from load to load; a page no test opened has none to count.
Third-party code is left out of the totals; VENDORED_* says which.
"""

import glob
import json
import os
import re
import sys

# FPP keeps a patched Limonade under www/api/lib, reported on its own line.
VENDORED_PHP = re.compile(r"^www/api/lib/")
VENDORED_JS = re.compile(
    r"\.min\.js$|^www/(bootstrap-table/js|jquery|wled|css|gulpfile)|^www/js/(fabric|fullcalendar|logic|sugar|zero-md)/"
    r"|^www/js/(jquery[^/]*|scalar)\.js$"
)
KEEP_JS = {"www/js/jquery4-compat.js"}


def relative(path):
    return path[len("/opt/fpp/"):] if path.startswith("/opt/fpp/") else None


def code_lines(source):
    """0-based lines of JS holding code rather than only comments or blanks.
    A small scanner: it knows strings and comments, and takes a regex literal
    for code, which at worst miscounts a line."""
    code, i, n, line, quote = set(), 0, len(source), 0, None
    while i < n:
        c = source[i]
        if c == "\n":
            line += 1
            if quote != "`":
                quote = None
        elif quote:
            code.add(line)
            if c == "\\":
                i += 1
                if i < n and source[i] == "\n":
                    line += 1
            elif c == quote:
                quote = None
        elif source.startswith("//", i):
            i = source.find("\n", i)
            if i < 0:
                break
            continue
        elif source.startswith("/*", i):
            end = source.find("*/", i + 2)
            end = n if end < 0 else end + 2
            line += source.count("\n", i, end)
            i = end
            continue
        elif c in " \t\r":
            pass
        else:
            code.add(line)
            if c in "'\"`":
                quote = c
        i += 1
    return code


def php_report(tree, raws):
    executable, hit, unreadable, uncounted = {}, {}, [], set()
    for raw in raws:
        path = os.path.join(raw, "php-lines.json")
        if os.path.exists(path):
            listed = json.load(open(path))
            uncounted.update(relative(f) for f in listed["uncounted"])
            for f, lines in listed["lines"].items():
                executable.setdefault(f, set()).update(lines)
        for path in glob.glob(os.path.join(raw, "php", "*.json")):
            try:
                d = json.load(open(path))
            except ValueError:
                unreadable.append(path)
                continue
            hit.setdefault(d["file"], set()).update(d["hit"])
    # With only the lines that ran to count, every file would read 100%.
    if hit and not executable:
        sys.exit("no executable lines listed for PHP (php-lines.json): was PCOV loaded?")
    rows = {}
    for f in set(executable) | set(hit):
        rel = relative(f)
        # Tests add files of their own to the served tree.
        if rel and os.path.exists(os.path.join(tree, rel)):
            ran = hit.get(f, set())
            rows[rel] = (len(executable.get(f, set()) | ran), len(ran))
    return rows, unreadable, sorted(uncounted)


def js_report(tree, raws):
    external, inline = {}, {}
    sources = {}
    for raw in raws:
        for path in glob.glob(os.path.join(raw, "js", "*.json")):
            d = json.load(open(path))
            source = sources.get(d["source"])
            if source is None:
                with open(os.path.join(raw, "js-src", d["source"] + ".js"), errors="replace", newline="") as f:
                    source = sources[d["source"]] = f.read()
            # A page of another player through /proxy runs this tree's code too.
            url = re.sub(r"^/proxy/[^/]+", "", d["path"])
            if url.endswith((".js", ".mjs")):
                external.setdefault("www" + url, set()).update(d["hit"])
            elif os.path.exists(os.path.join(tree, "www" + url + ("index.php" if url.endswith("/") else ""))):
                # Anything else is a page a test made up with a route.
                lines = source.split("\n")
                code = code_lines(source)
                texts = inline.setdefault(url, (set(), set()))
                for n in code:
                    texts[0].add(lines[n].strip())
                for n in d["hit"]:
                    if n in code:
                        texts[1].add(lines[n].strip())
    rows = {}
    for root, _, files in os.walk(os.path.join(tree, "www")):
        for name in files:
            if name.endswith((".js", ".mjs")):
                rel = os.path.relpath(os.path.join(root, name), tree)
                with open(os.path.join(tree, rel), errors="replace", newline="") as f:
                    code = code_lines(f.read())
                # V8's line numbers are of the served file, which is this one.
                rows[rel] = (len(code), len(code & external.get(rel, set())))
    return rows, {u: (len(t[0]), len(t[1])) for u, t in inline.items()}


def totals(rows):
    lines = sum(r[0] for r in rows.values())
    run = sum(r[1] for r in rows.values())
    return {"lines": lines, "lines_hit": run, "percent": round(100 * run / lines, 1) if lines else None,
            "files": len(rows), "files_unreached": sum(1 for r in rows.values() if r[0] and not r[1])}


def table(rows):
    return [{"file": f, "lines": n, "lines_hit": h, "unreached": n - h}
            for f, (n, h) in sorted(rows.items(), key=lambda kv: (kv[1][1] - kv[1][0], kv[0]))]


def main():
    tree, out, raws = sys.argv[1], sys.argv[2], sys.argv[3:]
    php, unreadable, uncounted = php_report(tree, raws)
    js, inline = js_report(tree, raws)
    www_php = {f: r for f, r in php.items() if f.startswith("www/") and not VENDORED_PHP.search(f)}
    vendored_php = {f: r for f, r in php.items() if VENDORED_PHP.search(f)}
    scripts_php = {f: r for f, r in php.items() if f.startswith("scripts/")}
    own_js = {f: r for f, r in js.items() if f in KEEP_JS or not VENDORED_JS.search(f)}
    data = {
        "php": dict(totals(www_php), by_file=table(www_php)),
        "php_vendored": totals(vendored_php),
        "php_scripts": dict(totals(scripts_php), by_file=table(scripts_php)),
        "js": dict(totals(own_js), by_file=table(own_js)),
        "js_inline": dict(totals(inline), by_page=table(inline)),
        "php_records_unreadable": len(unreadable),
        "php_files_uncounted": uncounted,
    }
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "totals.json"), "w") as f:
        json.dump(data, f, indent=1)
    names = [("PHP under www/", "php"), ("JS under www/", "js"), ("Scripts inside PHP pages", "js_inline"),
             ("PHP under scripts/", "php_scripts"), ("Limonade (www/api/lib)", "php_vendored")]
    with open(os.path.join(out, "summary.txt"), "w") as f:
        for label, key in names:
            d = data[key]
            f.write(f"{label}: {d['percent']}% ({d['lines_hit']} of {d['lines']} lines, "
                    f"{d['files_unreached']} of {d['files']} files never reached)\n")
        for label, key, rowskey in (("PHP under www/", "php", "by_file"), ("JS under www/", "js", "by_file"),
                                    ("Scripts inside PHP pages", "js_inline", "by_page"),
                                    ("PHP under scripts/", "php_scripts", "by_file")):
            f.write(f"\n{label}\n{'lines':>6} {'hit':>6} {'line%':>6}  file\n")
            for r in data[key][rowskey]:
                pct = 100 * r["lines_hit"] / r["lines"] if r["lines"] else 100
                f.write(f"{r['lines']:6} {r['lines_hit']:6} {pct:5.1f}%  {r['file']}\n")
    with open(os.path.join(out, "summary.md"), "w") as f:
        f.write("### PHP and JS under www/\n\n| Code | Line coverage | Lines | Files never reached |\n|---|---|---|---|\n")
        for label, key in names:
            d = data[key]
            f.write(f"| {label} | {d['percent']}% | {d['lines_hit']:,} of {d['lines']:,} | "
                    f"{d['files_unreached']} of {d['files']} |\n")
        for label, key in (("PHP", "php"), ("JS", "js")):
            f.write(f"\n**{label}: most lines not reached**\n\n| File | Lines | Not reached |\n|---|---|---|\n")
            for r in data[key]["by_file"][:15]:
                f.write(f"| {r['file']} | {r['lines']:,} | {r['unreached']:,} |\n")
    print(open(os.path.join(out, "summary.txt")).read().split("\n\n")[0])


if __name__ == "__main__":
    main()
