"""Mark ledger rows whose change master no longer contains.

    python3 scripts/ledger-supersede.py [--fpp ../fpp] [--to origin/master] [--rows-from OLD.tsv] LEDGER.tsv

For each `todo` row of LEDGER.tsv that is not in OLD.tsv (the rows others are
working from), look at what the commit added, file by file:

  * every file it touched was deleted later, and none was renamed: the row
    becomes `superseded` ("file removed");
  * the lines it added (stripped, 12+ characters, not a bare comment) are
    looked for in the file as master has it -- following renames -- and when
    none of at least three are there, the change was rewritten: `superseded`;
  * a change of eight or more lines of which a tenth or fewer are still there
    was mostly rewritten: `superseded` too;
  * anything else stays `todo`, and its note records how many of the added
    lines survive, so a person reading the rest can start with the changes
    master still holds.

Only the note of a row left `todo`, and the outcome and note of a row marked
`superseded`, are written; a row someone has already worked on (its note does
not start with "auto:") is never touched. Notes written here start with
"script check:" so ledger-update.py leaves them alone.
"""

import argparse
import collections
import csv
import re
import subprocess
import sys

COMMENT = re.compile(r"^(//|#|\*|/\*|\*/|<!--|-->)")


def git(fpp, *args):
    return subprocess.run(["git", "-C", fpp, *args], capture_output=True, text=True, errors="replace").stdout


def significant(line):
    s = line.strip()
    return len(s) >= 12 and not COMMENT.match(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fpp", default="../fpp")
    ap.add_argument("--to", default="origin/master")
    ap.add_argument("--rows-from", help="a ledger whose rows are left alone")
    ap.add_argument("ledger")
    a = ap.parse_args()

    keep = set()
    if a.rows_from:
        with open(a.rows_from) as f:
            keep = {r[0] for r in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)}
    with open(a.ledger) as f:
        rows = list(csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE))
    header, body = rows[0], rows[1:]
    todo = [r for r in body if r[1] == "todo" and r[0] not in keep and (r[4] == "" or r[4].startswith("auto:"))]
    print(f"{len(todo)} rows to check", file=sys.stderr)

    # Renames and deletions anywhere in the range, oldest first, so a chain of
    # moves can be followed to where a file is today.
    moved, deleted = {}, set()
    first = min((r[0] for r in todo), default=None)
    log = git(a.fpp, "log", "--reverse", "-M", "--diff-filter=RD", "--name-status", "--format=", f"{todo[-1][0]}~1..{a.to}") if todo else ""
    for line in log.splitlines():
        parts = line.split("\t")
        if parts[0].startswith("R") and len(parts) == 3:
            moved[parts[1]] = parts[2]
        elif parts[0] == "D" and len(parts) == 2:
            deleted.add(parts[1])

    exists_cache, lines_cache = {}, {}

    def at_master(path):
        # follow renames to where the file is now; None if it is gone
        seen = set()
        while path in moved and path not in seen:
            seen.add(path)
            path = moved[path]
        if path not in exists_cache:
            exists_cache[path] = subprocess.run(["git", "-C", a.fpp, "cat-file", "-e", f"{a.to}:{path}"],
                                                capture_output=True).returncode == 0
        return path if exists_cache[path] else None

    def master_lines(path):
        if path not in lines_cache:
            text = git(a.fpp, "show", f"{a.to}:{path}")
            lines_cache[path] = {l.strip() for l in text.splitlines()}
        return lines_cache[path]

    changed = collections.Counter()
    for r in todo:
        sha = r[0]
        diff = git(a.fpp, "show", "-M", "-U0", "--format=", sha)
        files, cur = collections.OrderedDict(), None
        for line in diff.splitlines():
            if line.startswith("+++ "):
                cur = line[6:] if line.startswith("+++ b/") else None
                if cur:
                    files.setdefault(cur, [])
            elif line.startswith("+") and cur:
                files[cur].append(line[1:])
        if not files:
            continue
        gone = [p for p in files if at_master(p) is None]
        total = surviving = 0
        for p, added in files.items():
            now = at_master(p)
            sig = [l for l in added if significant(l)]
            total += len(sig)
            if now:
                have = master_lines(now)
                surviving += sum(1 for l in sig if l.strip() in have)
        if len(gone) == len(files):
            r[1], r[4] = "superseded", "script check: every file this commit changed has since been removed from master"
            changed["file removed"] += 1
        elif total >= 5 and surviving == 0:
            r[1], r[4] = "superseded", f"script check: none of the {total} lines this commit added are in master any more"
            changed["rewritten"] += 1
        elif total >= 8 and surviving * 10 <= total:
            r[1], r[4] = "superseded", f"script check: only {surviving} of the {total} lines this commit added are still in master; the rest were rewritten"
            changed["mostly rewritten"] += 1
        else:
            where = "" if not gone else f"; {len(gone)} of {len(files)} files gone"
            r[4] = f"script check: {surviving} of {total} added lines are still in master{where}"
            changed["kept"] += 1

    with open(a.ledger, "w", newline="") as f:
        csv.writer(f, delimiter="\t", quoting=csv.QUOTE_NONE, quotechar=None, escapechar=None, lineterminator="\n").writerows([header] + body)
    print(dict(changed), file=sys.stderr)


if __name__ == "__main__":
    main()
