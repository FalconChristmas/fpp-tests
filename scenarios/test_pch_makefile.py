"""How the makefiles treat the precompiled header (fpp-pch.h.gch), read from
make itself: the compile line it would run, and whether it considers the
header out of date after a source it depends on changes.

The suite builds fpp with DISTRIBUTED_COMPILE=1, which has no precompiled
header, so nothing else here ever runs the PCH rules. These run make in a
copy of the tree's src/ (its objects left out) without that variable.
"""

import os
import shlex
import shutil
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")
HEADER_PCH = "fpp-pch.h.gch"


@pytest.fixture
def src(tmp_path):
    """A copy of the tree's src/ without what was built from it."""
    if not TREE or not os.path.isdir(os.path.join(TREE, "src")):
        pytest.skip("needs an fpp tree")
    if not shutil.which("make") or not shutil.which("g++"):
        pytest.skip("needs make and g++")
    pack = subprocess.run(
        ["tar", "-C", TREE, "--exclude=*.o", "--exclude=*.so", "--exclude=*.so.*", "--exclude=*.d",
         "--exclude=*.a", "--exclude=*.gch", "--exclude=*.gch.sum", "--exclude=src/fppd", "-cf", "-", "src"],
        capture_output=True, timeout=300)
    assert pack.returncode == 0, pack.stderr[-1000:]
    subprocess.run(["tar", "-C", str(tmp_path), "-xf", "-"], input=pack.stdout, check=True, timeout=300)
    return tmp_path / "src"


def env():
    keep = {k: v for k, v in os.environ.items() if k not in ("DISTRIBUTED_COMPILE", "DISTCC_HOSTS", "NOCC_SERVERS")}
    return dict(keep, CCACHE_DISABLE="1", CCACHE="", MAKEFLAGS="")


def make(src, *args, timeout=900):
    return subprocess.run(["make", "-C", str(src), *args], capture_output=True, text=True, timeout=timeout, env=env())


def compile_lines(src, target):
    """The compile commands `make -n target` prints, by the file they compile."""
    r = make(src, "-n", target)
    assert r.returncode == 0, r.stdout[-1500:] + r.stderr[-1500:]
    lines = {}
    for line in r.stdout.splitlines():
        if " -c " in line:
            toks = shlex.split(line)
            lines[os.path.basename(toks[toks.index("-o") + 1] if "-o" in toks else toks[toks.index("-c") + 1])] = toks
    return lines


def test_the_pch_is_compiled_with_the_flags_the_objects_that_use_it_get(src):
    """The precompiled header is built with -fpch-preprocess, -Winvalid-pch and
    -g1, the flags every object that uses it is compiled with, even when the
    first object that needs it is one of the fppinit objects, which opt out of
    the PCH and drop those flags.

    Regression: 1f121a36c. A target's variables are inherited by its
    prerequisites, so the header built for the fppinit object (always the
    first one built) took that object's filtered flags, and gcc then threw the
    header away for every other file, silently, so the whole tree compiled
    without a PCH while still building one.

    Also b55176edd: the flags fppinit drops come from one variable
    (PCH_CFLAGS), so -Winvalid-pch, added later than the rest, is dropped
    with them rather than staying on objects that do not use the PCH.
    """
    lines = compile_lines(src, "boot/FPPINIT.o")
    pch_only = {"-fpch-preprocess", "-Winvalid-pch", "-g1"}
    pch = lines[HEADER_PCH]
    assert pch_only <= set(pch), sorted(pch_only - set(pch))
    # The control: the PCH's line is the one inherited from a prerequisite
    # of the fppinit object, and that object's line is a different one.
    init = lines["FPPINIT.o"]
    assert pch is not init
    assert not pch_only & set(init), sorted(pch_only & set(init))


def test_the_pch_is_rebuilt_when_a_header_it_includes_changes(src):
    """Touching any header the PCH includes, directly or through another,
    makes make rebuild it; touching one it does not include does not.

    Regression: 16133800e. The PCH's prerequisites were a hand-written list
    that had drifted (fpp-json.h and Events.h absent, common_mini.h one level
    under common.h), so editing one of those left the PCH "up to date" and
    every file compiled against its stale declarations.

    Also 5a4998171: the makefile fragments are prerequisites too, since they
    decide the flags it was built with.
    """
    built = make(src, HEADER_PCH)
    assert built.returncode == 0, built.stdout[-1500:] + built.stderr[-3000:]
    assert (src / HEADER_PCH).exists()

    clock = [os.stat(src / HEADER_PCH).st_mtime]

    def stale():
        return make(src, "-q", HEADER_PCH).returncode == 1

    def change(name):
        """`name` is edited after the PCH was built; afterwards the PCH is
        taken as rebuilt, newer than that."""
        clock[0] += 10
        os.utime(src / name, (clock[0], clock[0]))
        return stale

    def rebuilt():
        clock[0] += 10
        os.utime(src / HEADER_PCH, (clock[0], clock[0]))

    rebuilt()
    assert not stale(), "the control: a PCH just built should be up to date"
    dep_file = src / "fpp-pch.h.d"
    deps = dep_file.read_text() if dep_file.exists() else ""
    for name in ("common_mini.h", "fpp-json.h", "Events.h", "makefiles/fppd.mk"):
        assert change(name)(), f"{name} changed and the PCH was not rebuilt"
        rebuilt()
    unrelated = next(h for h in sorted(os.listdir(src)) if h.endswith(".h") and h not in deps)
    assert not change(unrelated)(), f"{unrelated} is not in the PCH but rebuilt it"


def test_a_plugin_compiles_with_the_gstreamer_and_drm_flags_the_core_does():
    """What a plugin's makefile sees after including makefiles/common/setup.mk
    carries gstreamer's and libdrm's compile flags (-pthread, the -I paths),
    as the core's does.

    Regression: 5a4998171. Those flags were added in a fragment only the core
    read, so a plugin was compiled with _REENTRANT undefined (gcc then refused
    the PCH) and without gstreamer's -I, where the headers choose a class
    layout by __has_include(<gst/gst.h>): a different layout from libfpp's.
    """
    if not TREE:
        pytest.skip("needs an fpp tree")
    wanted = []
    if os.path.exists("/usr/include/gstreamer-1.0/gst/gst.h"):
        wanted += subprocess.run(["pkg-config", "--cflags", "gstreamer-1.0", "gstreamer-app-1.0", "gstreamer-net-1.0"],
                                 capture_output=True, text=True, check=True).stdout.split()
    if os.path.exists("/usr/include/xf86drm.h"):
        wanted += subprocess.run(["pkg-config", "--cflags", "libdrm"], capture_output=True, text=True, check=True).stdout.split()
    if not wanted:
        pytest.skip("no gstreamer or libdrm headers here")
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "Makefile"), "w") as f:
            f.write(f"SRCDIR := {TREE}/src\ninclude $(SRCDIR)/makefiles/common/setup.mk\n"
                    "show:\n\t@echo 'CFLAGS=$(CFLAGS)'\n")
        r = subprocess.run(["make", "-s", "-f", "Makefile", "show"], cwd=d, capture_output=True, text=True,
                           timeout=60, env=env())
        assert r.returncode == 0, r.stdout[-1000:] + r.stderr[-2000:]
    flags = r.stdout.split("CFLAGS=", 1)[1].split()
    missing = [w for w in dict.fromkeys(wanted) if w not in flags]
    assert not missing, missing
