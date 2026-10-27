"""The harness itself: what fppd's children inherit when fppd.start()
preloads something into a sanitizer-built fppd. The sanitizer runtime has to
be preloaded ahead of any shim or libfaketime, but the programs fppd starts
must not get it: they aren't built with it, and fail to start or crash
under it. A scenario that preloads anything would otherwise be testing a
player whose scripts and system tools don't run."""

import os
import time

import pytest

import shims
from audio import write_tone_wav


@pytest.mark.parametrize("how", ["preload", "fake_time"])
def test_fppds_children_run_without_its_sanitizer_runtime(fppd, audio, how):
    """fppd started with a shim preloaded, and with libfaketime (which
    preloads the runtime too): a Run Script started by fppd sees no
    sanitizer runtime in LD_PRELOAD but still sees the shim; pw-dump and
    pw-link, not built with a sanitizer, talk to the audio fixture's
    PipeWire; fpp, built with fppd's sanitizer, runs too with the shim
    preloaded ahead of its own runtime; and a track played then starts
    without waiting out the persistent output stream's 3 s link check (the
    pw-link fppd runs itself).

    Regression: harness, under ASan. fppd.py took only TSan's runtime back
    out (noinherit.c). Under ASan every child kept libasan in LD_PRELOAD:
    pw-link, pw-cli and pw-dump died at once (SIGILL), so with any preload
    fppd's persistent output stream was never linked and every track
    started 3 s late ("not ready ... starting anyway"), and fppd's own
    pw-cli and pw-dump lookups found nothing."""
    out = os.path.join(fppd.media, "tmp", "child.out")
    fpp = os.path.join(fppd.tree, "src", "fpp")
    os.chmod(fppd.write("scripts/child.sh", f"""#!/bin/bash
{{
  echo "preload=$LD_PRELOAD"
  export PIPEWIRE_RUNTIME_DIR=/run/pipewire-fpp XDG_RUNTIME_DIR=/run/pipewire-fpp
  pw-dump >/dev/null 2>&1; echo "pw-dump=$?"
  pw-link -o >/dev/null 2>&1; echo "pw-link=$?"
  echo "fpp=$({fpp} --no-such-option 2>&1 | grep -c '^Usage:')"
}} > {out}.tmp
mv {out}.tmp {out}
"""), 0o755)
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 3)
    if how == "preload":
        fppd.start(preload=[shims.build("emptyshim.c", libs=())])
    else:
        fppd.start(fake_time="2026-06-01 12:00:00")
    fppd.command("Run Script", "child.sh", "", "")
    fppd.wait_for(lambda: os.path.exists(out), timeout=15, what="the script to run")
    got = dict(line.split("=", 1) for line in open(out).read().split("\n") if "=" in line)
    assert "libasan" not in got["preload"] and "libtsan" not in got["preload"], got
    if how == "preload":
        assert "emptyshim" in got["preload"], got
    assert got["pw-dump"] == "0" and got["pw-link"] == "0", got
    # fpp prints its usage for an unknown option -- unless ASan refused to
    # start it, or it crashed.
    assert got["fpp"] == "1", got
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    time.sleep(4)
    late = [line for line in fppd.log().splitlines() if "not ready after" in line]
    assert not late, late
