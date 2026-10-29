"""src/fppversion.sh, which every build runs to stamp FPP's version into
fppd (fppversion.c, fppversion_defines.h) and the web UI
(www/fppversion.php), run against a small git repository of the scenario's
whose tags are set up as the release workflow leaves them."""

import os
import shutil
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                   check=True, capture_output=True, timeout=30)


def test_the_version_comes_from_the_release_tag_not_the_nightly_tag(tmp_path):
    """The version is the nearest release tag (a lightweight one, as CI
    makes them) even when the moving lightweight "nightly" tag sits on a
    newer commit: the major version is a number, and the PHP the UI loads
    gets a numeric version.

    Regression: 097c6d95a. "git describe --tags" took whichever tag was
    nearest, so a tree at the nightly tag came out as version "nightly",
    major version "nightly", and getFPPVersionFloat() returned
    nightly.nightly -- an undefined constant to PHP.
    """
    if not shutil.which("git"):
        pytest.skip("no git")
    repo = tmp_path / "fpp"
    (repo / "src").mkdir(parents=True)
    (repo / "www").mkdir()
    shutil.copy(os.path.join(TREE, "src", "fppversion.sh"), repo / "src" / "fppversion.sh")
    git(repo, "init", "-q", "-b", "master")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "release")
    git(repo, "tag", "10.3")                       # lightweight, as gh api .../git/refs makes it
    (repo / "README").write_text("later\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "a later commit")
    git(repo, "tag", "nightly")                    # the nightly job's moving tag, on HEAD

    r = subprocess.run(["sh", str(repo / "src" / "fppversion.sh"), str(repo / "src")],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    defines = (repo / "src" / "fppversion_defines.h").read_text()
    assert "#define FPP_MAJOR_VERSION 10\n" in defines, defines
    assert "#define FPP_MINOR_VERSION 3\n" in defines, defines
    assert '#define FPP_SOURCE_VERSION_STR "10.3-1-g' in defines, defines

    php = subprocess.run(["php", "-d", "short_open_tag=1", "-r",
                          f'include "{repo}/www/fppversion.php"; '
                          'echo json_encode([getFPPVersionFloat(), getFPPMajorVersion()]);'],
                         capture_output=True, text=True, timeout=30)
    assert php.stdout.strip() == '[10.3,"10"]', php.stdout + php.stderr
