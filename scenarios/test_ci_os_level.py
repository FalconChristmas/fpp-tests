"""The "Determine OS level" step of the image build workflow
(.github/workflows/build-images.yml): the OS level written into each image
and .fppos name is the build month, and a second release in a month gets the
next letter so players on the first are offered the second's OS update.

The step's shell is taken out of the workflow file as it stands and run with
a stand-in `gh` that serves a list of releases (the GitHub API's shape, run
through the step's own jq filter) and a fixed `date`; no network, no runner.
"""

import json
import os
import re
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")
WORKFLOW = os.path.join(TREE, ".github/workflows/build-images.yml")


def step_script():
    """The run: block of the step named "Determine OS level", dedented."""
    lines = open(WORKFLOW).read().split("\n")
    start = next(i for i, l in enumerate(lines) if l.strip() == "- name: Determine OS level")
    run = next(i for i in range(start, len(lines)) if re.match(r"\s+run: \|\s*$", lines[i]))
    indent = len(lines[run]) - len(lines[run].lstrip())
    body = []
    for l in lines[run + 1:]:
        if l.strip() and len(l) - len(l.lstrip()) <= indent:
            break
        body.append(l)
    block = [len(l) - len(l.lstrip()) for l in body if l.strip()]
    cut = min(block)
    return "\n".join(l[cut:] for l in body)


def release(tag, *names):
    return {"tag_name": tag, "assets": [{"name": n} for n in names]}


def os_level(tmp_path, releases, version="10.3", is_release=True, month="2026-10"):
    """(exit status, os_version output, the step's output) for a build of
    `version` while GitHub lists `releases`."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (tmp_path / "releases.json").write_text(json.dumps(releases))
    # gh api --paginate URL -q FILTER: the filter is the step's own.
    gh = bindir / "gh"
    gh.write_text(f"""#!/bin/sh
[ "$1" = api ] || exit 2
shift
while [ $# -gt 0 ]; do
    case "$1" in
    -q) FILTER="$2"; shift 2 ;;
    *) shift ;;
    esac
done
exec jq -r "$FILTER" {tmp_path}/releases.json
""")
    date = bindir / "date"
    date.write_text(f"#!/bin/sh\necho {month}\n")
    for p in (gh, date):
        p.chmod(0o755)
    script = step_script()
    script = script.replace("${{ steps.ver.outputs.is_release }}", "true" if is_release else "false")
    script = script.replace("${{ steps.ver.outputs.version }}", version)
    script = script.replace("${{ github.repository }}", "example/fpp")
    assert "${{" not in script, script
    out = tmp_path / "github_output"
    out.write_text("")
    r = subprocess.run(["bash", "-e", "-c", script], capture_output=True, text=True, timeout=60,
                       env=dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", GITHUB_OUTPUT=str(out)))
    m = re.search(r"^os_version=(.*)$", out.read_text(), re.M)
    return r.returncode, (m.group(1) if m else None), r.stdout + r.stderr


def fppos(level, platform="Pi64", version="10.2"):
    return f"FPP-{version}-{platform}_{level}.fppos"


def test_first_release_of_the_month_gets_the_bare_month(tmp_path):
    """No other release used the month (earlier months' images do not count),
    so the level is the month.

    Regression: 867ef3f7f. The level was always the month; the letters are
    only added once a release has used it.
    """
    rel = [release("10.2", fppos("2026-09")), release("10.1", fppos("2026-09b")), release("nightly")]
    assert os_level(tmp_path, rel)[:2] == (0, "2026-10")


def test_a_second_release_in_a_month_gets_the_next_letter(tmp_path):
    """One release used 2026-10 (an unlettered name is the month's first), so
    the next gets 2026-10b; with 2026-10b taken as well, 2026-10c.

    Regression: 867ef3f7f. Two releases in one month shipped the same OS
    level, so a player on the first release's image was never offered the
    second's OS update.
    """
    rel = [release("10.2", fppos("2026-10", "Pi"), fppos("2026-10", "BBB"))]
    assert os_level(tmp_path, rel)[:2] == (0, "2026-10b")
    rel.append(release("10.2.1", fppos("2026-10b", "Pi"), "FPP-10.2.1-Pi_2026-10b.img.zip"))
    assert os_level(tmp_path, rel, version="10.2.2")[:2] == (0, "2026-10c")


def test_a_rebuild_of_a_release_keeps_its_level(tmp_path):
    """The release being built is left out of the list, so rebuilding the one
    that took 2026-10b gets 2026-10b again, not 2026-10c.

    Regression: 867ef3f7f.
    """
    rel = [release("10.2", fppos("2026-10")), release("10.3", fppos("2026-10b", "Pi"))]
    assert os_level(tmp_path, rel, version="10.3")[:2] == (0, "2026-10b")
    assert os_level(tmp_path, rel, version="10.4")[:2] == (0, "2026-10c")


def test_nightlies_and_one_off_builds_keep_the_bare_month(tmp_path):
    """Only a release build takes a letter; a nightly or other build keeps the
    month even when releases used it, and the nightly release's own assets
    never count towards a release's letter.

    Regression: 867ef3f7f.
    """
    rel = [release("10.2", fppos("2026-10")), release("nightly", fppos("2026-10b", "Pi"))]
    assert os_level(tmp_path, rel, version="nightly", is_release=False)[:2] == (0, "2026-10")
    assert os_level(tmp_path, rel, version="10.3")[:2] == (0, "2026-10b")


def test_the_last_letter_fails_the_build_rather_than_reusing_a_level(tmp_path):
    """With 2026-10z used there is no next level: the step fails, and sets no
    output, instead of guessing (a reused level hides the OS update).

    Regression: 867ef3f7f.
    """
    rel = [release("10.2", fppos("2026-10z"))]
    status, level, log = os_level(tmp_path, rel)
    assert status != 0, log
    assert level is None, log
    assert "every OS level letter for 2026-10 is used" in log
