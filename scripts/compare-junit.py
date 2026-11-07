"""Compare two runs of the same suite, for the CI workflow: did they fail the
same tests?

    python3 scripts/compare-junit.py LABEL_A DIR_A LABEL_B DIR_B

Each DIR holds a run's junit.xml files, one per shard, anywhere below it.
Prints Markdown for the run's summary page: whether the two failed the same
tests, and which tests failed in one run only or ran in one run only. Used to
check that web-coverage (the web suite with --www-coverage) fails nothing the
plain web job doesn't, before the two are merged into one run. Always exits 0:
it reports, it does not judge.
"""

import glob
import os
import sys
import xml.etree.ElementTree as ET


def outcomes(d):
    """{test id: 'passed' | 'failed' | 'skipped'}, and how many junit.xml files were read."""
    out = {}
    files = sorted(glob.glob(os.path.join(d, "**", "junit.xml"), recursive=True))
    for path in files:
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError):
            continue
        for case in root.iter("testcase"):
            key = f'{case.get("classname", "")} › {case.get("name", "")}'
            if case.find("failure") is not None or case.find("error") is not None:
                out[key] = "failed"
            elif case.find("skipped") is not None:
                out.setdefault(key, "skipped")
            else:
                out.setdefault(key, "passed")
    return out, len(files)


def main():
    la, da, lb, db = sys.argv[1:5]
    a, na = outcomes(da)
    b, nb = outcomes(db)
    print(f"### Same failures as `{la}`?\n")
    if not na or not nb:
        missing = [lbl for lbl, n in ((la, na), (lb, nb)) if not n]
        print(f"Can't tell: no results from {' or '.join(f'`{m}`' for m in missing)}.")
        return
    fa = {t for t, s in a.items() if s == "failed"}
    fb = {t for t, s in b.items() if s == "failed"}
    both = set(a) & set(b)
    only_b = sorted(t for t in fb - fa if t in both)
    only_a = sorted(t for t in fa - fb if t in both)
    ran_a, ran_b = sorted(set(a) - set(b)), sorted(set(b) - set(a))
    same = not only_a and not only_b
    print(("**Yes.** " if same else "**No.** ")
          + f"`{la}`: {len(a)} tests, {len(fa)} failed. `{lb}`: {len(b)} tests, {len(fb)} failed. "
          + f"{len(fa & fb)} failed in both.\n")
    for title, tests in ((f"Failed only in `{lb}`", only_b), (f"Failed only in `{la}`", only_a),
                         (f"Ran only in `{la}`", ran_a), (f"Ran only in `{lb}`", ran_b)):
        if tests:
            print(f"<details><summary>{title} ({len(tests)})</summary>\n")
            for t in tests[:100]:
                print(f"- {t}")
            if len(tests) > 100:
                print(f"- … and {len(tests) - 100} more")
            print("\n</details>\n")


if __name__ == "__main__":
    main()
