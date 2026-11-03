"""src/Makefile's targets for the plugins installed in the media directory:
`make plugins`, `make cleanplugins` and `make rebuildplugins` run each
plugin's own Makefile. They name /home/fpp/media/plugins; here a copy of the
tree's src/Makefile has that path pointed at plugins of the test's own, whose
Makefiles record what they are asked."""

import os
import shutil
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")
PLUGINS = "/home/fpp/media/plugins"

PLUGIN_MAKEFILE = """all:
\t@echo build >> calls
clean:
\t@echo clean >> calls
"""


@pytest.fixture
def src(tmp_path):
    """The tree's src/ makefiles, with the plugins directory moved into tmp_path."""
    if not TREE or not os.path.isfile(os.path.join(TREE, "src", "Makefile")):
        pytest.skip("needs an fpp tree")
    if not shutil.which("make"):
        pytest.skip("needs make")
    dst = tmp_path / "src"
    dst.mkdir()
    for name in os.listdir(os.path.join(TREE, "src")):
        p = os.path.join(TREE, "src", name)
        if name == "Makefile":
            with open(p) as f:
                text = f.read()
            assert PLUGINS in text, "src/Makefile no longer names the plugins directory"
            (dst / name).write_text(text.replace(PLUGINS, str(tmp_path / "plugins")))
        elif name == "makefiles" or name.endswith(".mk"):
            shutil.copytree(p, dst / name) if os.path.isdir(p) else shutil.copy(p, dst / name)
    plugins = tmp_path / "plugins"
    for name in ("one", "two"):
        (plugins / name).mkdir(parents=True)
        (plugins / name / "Makefile").write_text(PLUGIN_MAKEFILE)
    (plugins / "nomake").mkdir()
    (plugins / "nomake" / "README").write_text("no Makefile here\n")
    return dst


def make(src, target):
    env = {k: v for k, v in os.environ.items() if k not in ("MAKEFLAGS", "MFLAGS", "MAKELEVEL")}
    r = subprocess.run(["make", "-C", str(src), target], capture_output=True, text=True, timeout=120, env=env)
    assert r.returncode == 0, f"make {target} exited {r.returncode}\n{r.stdout[-1500:]}{r.stderr[-1500:]}"
    return r.stdout


def calls(src, name):
    p = src.parent / "plugins" / name / "calls"
    return p.read_text().split() if p.exists() else []


def test_rebuildplugins_cleans_then_builds_each_plugin_with_a_makefile(src):
    """`make rebuildplugins` runs every installed plugin's Makefile: clean,
    then the default target, and passes over a plugin with no Makefile.
    `make plugins` alone builds without cleaning.

    Regression: bda7cbdb1 ("Add a couple Makefile targets for (re)building
    all plugins"). There was no way to rebuild the plugins' native code after
    an fppd rebuild short of running make in each plugin by hand."""
    out = make(src, "rebuildplugins")
    for name in ("one", "two"):
        assert calls(src, name) == ["clean", "build"], f"{name}: {calls(src, name)}\n{out}"
        assert f"Cleaning plugin {src.parent / 'plugins' / name}" in out, out
        assert f"Building plugin {src.parent / 'plugins' / name}" in out, out
    assert "nomake" not in out, out
    make(src, "plugins")
    assert calls(src, "one") == ["clean", "build", "build"], calls(src, "one")
