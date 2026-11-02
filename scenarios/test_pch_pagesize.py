"""The precompiled header's guard against the kernel page size
(src/Makefile): a gcc .gch is only valid under the page size it was
written with, so the makefile keeps a stamp of it and rebuilds the .gch
when it changes, and puts it in the .gch's ccache key.

A scratch copy of the tree's Makefile and makefiles, a .gch that is up to
date, and a getconf stand-in on PATH for the page size; make -n says
whether the .gch would be rebuilt and with what ccache key.
"""

import os
import shutil
import subprocess

TREE = os.environ.get("FPP_TREE", "")


def make_n(src, pagesize, tmp_path):
    """`make -n fpp-pch.h.gch` in `src` as a kernel with `pagesize` pages;
    returns the commands it would run."""
    stub = tmp_path / "bin"
    stub.mkdir(exist_ok=True)
    (stub / "getconf").write_text(f"#!/bin/sh\necho {pagesize}\n")
    (stub / "getconf").chmod(0o755)
    r = subprocess.run(["make", "-n", "fpp-pch.h.gch"], cwd=src, capture_output=True, text=True, timeout=60,
                       env=dict(os.environ, PATH=f"{stub}:{os.environ['PATH']}"))
    assert r.returncode == 0, r.stdout[-1000:] + r.stderr[-2000:]
    return r.stdout


def scratch(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    for name in ("Makefile", "fpp-pch.h"):
        shutil.copy(f"{TREE}/src/{name}", src / name)
    shutil.copytree(f"{TREE}/src/makefiles", src / "makefiles")
    return src


def built(src):
    """The .gch as a build leaves it: newer than everything it depends on
    so far, which a stamp written afterwards is not."""
    (src / "fpp-pch.h.gch").write_text("gch")
    os.utime(src / "fpp-pch.h.gch")


def test_the_pch_is_rebuilt_when_the_kernel_page_size_changes(tmp_path):
    """A .gch built under 4K pages is rebuilt, under a ccache key naming the
    page size, when the kernel has 16K pages -- and rebuilt again on the
    way back to 4K; an unchanged page size leaves it alone.

    Regression: f17bcd077. After a Pi was switched to the 16K-page kernel
    nothing noticed: make saw the .gch as up to date and ccache gave the
    4K one back, so every translation unit segfaulted in cc1plus."""
    src = scratch(tmp_path)
    assert "pagesize" not in make_n(src, 4096, tmp_path)
    built(src)
    assert "-c " not in make_n(src, 4096, tmp_path), "up to date on the page size it was built under"

    out = make_n(src, 16384, tmp_path)
    assert "CCACHE_NAMESPACE=" in out and "pagesize16384" in out and "-c " in out, out
    built(src)
    assert "-c " not in make_n(src, 16384, tmp_path), "up to date on the 16K it was rebuilt under"

    out = make_n(src, 4096, tmp_path)
    assert "-c " in out, "back on 4K pages the .gch built for 16K is stale: " + out


def test_a_4k_page_build_keeps_the_pch_and_ccache_keys_it_had(tmp_path):
    """On 4K pages, the .gch's compile has no page size in its ccache key
    and no stamp is written, so a 4K build neither rebuilds its .gch for
    the guard nor misses the published caches.

    Regression: f316b8e68. The guard wrote its stamp and added the
    namespace on every box, so every 4K-page build compiled its .gch once
    for nothing and then missed the cache on every object."""
    src = scratch(tmp_path)
    out = make_n(src, 4096, tmp_path)
    assert "-c " in out and "CCACHE_NAMESPACE" not in out, out
    assert not (src / ".pch-pagesize").exists(), "a 4K box writes no stamp"
    built(src)
    assert "-c " not in make_n(src, 4096, tmp_path)
    assert not (src / ".pch-pagesize").exists()
