"""The master volume on the ALSA backend, seen by the amixer fppd runs: the
mixer control's name reaches it as one argument, spaces and all."""

import os
import stat
import tempfile

AMIXER = """#!/bin/sh
# fpp-tests stand-in for amixer: one line per call, each argument in [].
line=
for a in "$@"; do line="$line[$a]"; done
echo "$line" >> "$AMIXER_LOG"
"""


def stub_amixer(fppd):
    """A directory with an amixer that logs its arguments, and fppd's PATH
    with it in front; returns (log file, environment for fppd)."""
    d = tempfile.mkdtemp(prefix="amixer-")
    log = os.path.join(d, "calls.log")
    open(log, "w").close()
    path = os.path.join(d, "amixer")
    with open(path, "w") as f:
        f.write(AMIXER)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return log, {"PATH": d + ":" + os.environ.get("PATH", ""), "AMIXER_LOG": log}


def amixer_set_calls(log):
    with open(log) as f:
        return [l.strip() for l in f if l.startswith("[set]")]


def test_a_mixer_name_with_spaces_is_one_argument_to_amixer(fppd):
    """With the ALSA backend and a mixer control called "Main Digital", the
    master volume runs `amixer set -c 0 "Main Digital" -- N%`: the name is a
    single argument.

    Regression: 6924aff8a. The name went into the shell command bare, so
    amixer was given "Main" and "Digital" and set nothing on a card whose
    control has a space in its name."""
    log, env = stub_amixer(fppd)
    fppd.settings(MediaBackend="alsa", AudioMixerDevice="Main Digital", AudioOutput="0")
    fppd.start(extra_env=env)
    fppd.post("/fppd/volume/60")
    # 60% on fppd's cubic taper is 21.60% of the control's range; a call or
    # two for the volume fppd started with may come first.
    fppd.wait_for(lambda: any(c.endswith("[21.60%]") for c in amixer_set_calls(log)), timeout=10,
                  what="amixer set to run for 60%")
    call = [c for c in amixer_set_calls(log) if c.endswith("[21.60%]")][-1]
    assert call.startswith("[set][-c][0][Main Digital][--]["), f"amixer was run as {call}"
