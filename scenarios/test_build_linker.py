"""Which linker fpp's build used, read from what it built: mold and gold
each leave their name in an ELF's .comment section, GNU ld leaves none.
"""

import os
import shutil
import subprocess

import pytest


def comment(path):
    out = subprocess.run(["readelf", "-p", ".comment", path], capture_output=True, text=True)
    return out.stdout


@pytest.mark.parametrize("built", ["src/fppd", "src/libfpp.so"])
def test_the_build_links_with_mold_when_it_is_installed(fppd, built):
    """With /usr/bin/ld.mold installed (the Docker image and the FPP OS
    images have it), fppd and libfpp.so are linked by mold.

    Feature: 315fc317f. The makefiles always linked with the compiler's
    default, GNU ld, several times slower on the large shared objects.
    """
    if not os.path.exists("/usr/bin/ld.mold"):
        pytest.skip("mold is not installed here")
    if not shutil.which("readelf"):
        pytest.skip("no readelf")
    path = os.path.join(fppd.tree, built)
    if not os.path.exists(path):
        pytest.skip(f"the tree has no {built}")
    assert "mold" in comment(path), comment(path)


def test_fppd_is_linked_with_a_run_path_to_the_build_and_rf24(fppd):
    """fppd carries a run path to the directory it was built in and to the
    external RF24 library's, so it starts on a BeagleBone with no
    LD_LIBRARY_PATH set.

    Regression: e07485808. fppd was linked without one, so there it did not
    start ("libfpp.so: cannot open shared object file"). The Docker build adds
    $ORIGIN to every program, which finds libfpp.so whatever this says; what
    the fix added is read from the ELF's run path.
    """
    if not shutil.which("readelf"):
        pytest.skip("no readelf")
    path = os.path.join(fppd.tree, "src", "fppd")
    if not os.path.exists(path):
        pytest.skip("the tree has no src/fppd")
    dynamic = subprocess.run(["readelf", "-d", path], capture_output=True, text=True).stdout
    runpath = [l for l in dynamic.splitlines() if "RUNPATH" in l or "RPATH" in l]
    assert any(os.path.join(fppd.tree, "src") in l and "external/RF24" in l for l in runpath), runpath
