"""`make local` in src/: build what is in the tree without touching the
submodules, read from make -n in a copy of the tree's src/ (nothing is
compiled)."""

from test_pch_makefile import make, src  # noqa: F401  (src is a fixture)

SUBMODULES = "SUBMODULES=external/RF24"


def test_local_builds_the_targets_without_updating_the_submodules(src):
    """`make local` builds the same targets as `make all` but never runs the
    submodule sync/update step that `all` does first.

    Regression: 736745b3a. The only way to build the tree was `all`, which
    syncs and fetches every submodule from the network first, so a build of
    local changes (a checkout with no network, or externals deliberately left
    at an older commit) was held up or had its externals moved.
    """
    # The control: with submodules listed, `all` does run the update.
    r = make(src, "-n", SUBMODULES, "all")
    assert r.returncode == 0, r.stdout[-1500:] + r.stderr[-1500:]
    assert "git submodule update" in r.stdout, "the control: all no longer updates submodules, so this proves nothing"

    r = make(src, "-n", SUBMODULES, "local")
    assert r.returncode == 0, r.stdout[-1500:] + r.stderr[-1500:]
    assert "git submodule" not in r.stdout
    compiles = [l for l in r.stdout.splitlines() if " -c " in l]
    assert len(compiles) > 50, "local planned no build: " + r.stdout[-800:]
