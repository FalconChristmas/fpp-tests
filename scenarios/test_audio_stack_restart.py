"""fppd and a PipeWire stack restarted under it: the GStreamer PipeWire
plugin keeps its daemon connection for the life of the process, so whatever
restarts the stack has to restart fppd too."""

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

# fpp, as the sandbox runs it: record the call. setupAudio asks fppd to
# re-exec itself with "fpp -r" (ac141d68a; "systemctl restart fppd" before).
FPP = """#!/bin/sh
printf '%s\\n' "fpp $*" >> /fppinit-calls.log
"""


@pytest.mark.parametrize("fppd_running", [True, False])
def test_setup_audio_restarts_fppd_after_restarting_pipewire_under_it(fppinit, fppd_running):
    """setupAudio with a changed audio group config, so it restarts the
    PipeWire stack: with fppd running (an audio settings apply), fppd is
    restarted after the stack, so it reconnects; at boot, with fppd not
    started yet, it is not.

    Regression: f60c3651b. The GStreamer PipeWire plugin caches its daemon
    connection for the life of the process, so after setupAudio restarted
    the stack every later pipewiresink in fppd reused a dead connection:
    an audio settings apply left fppd silent until it was restarted by
    hand. The sandbox hides /.dockerenv, which skips the stack in Docker;
    its systemctl answers is-active from the state set here. Not covered:
    the PHP apply paths (settings.php, pipewire.php, resetConfig.php)."""
    fppinit.settings(MediaBackend="pipewire")
    fppinit.write("config/pipewire-audio-groups.json", {"groups": [
        {"id": 1, "name": "Main", "enabled": True, "channels": 2, "volume": 100,
         "members": [{"cardId": "x", "channels": 2, "delayMs": 0, "volume": 100}]}]})
    fppinit.service("fppd", active=fppd_running)
    fppinit.service("fpp-pipewire", active=True)
    fppinit.root_file("/opt/fpp/src/fpp", FPP)
    fppinit.root_file("/.dockerenv", None)
    r = fppinit.run("setupAudio", timeout=240)
    out = r.stdout + r.stderr
    assert r.returncode == 0, out[-3000:]
    calls = fppinit.calls()
    stack = [i for i, c in enumerate(calls) if c.startswith("systemctl restart fpp-pipewire.service")]
    assert stack, f"precondition: the PipeWire stack was restarted: {calls}\n{out[-2000:]}"
    fppd = [i for i, c in enumerate(calls) if c in ("fpp -r", "systemctl restart fppd")]
    if fppd_running:
        assert fppd and fppd[-1] > stack[-1], \
            f"fppd was not restarted after the stack: {calls[-4:]}\n{out[-2000:]}"
    else:
        assert not fppd, f"fppd restarted at boot: {calls}"
