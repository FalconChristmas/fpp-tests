"""scripts/fppd_restart: it clears the restart-needed flag in the media
directory's settings file, then stops and starts fppd.

It runs in the fppinit sandbox (fppinit.py) with fppd_stop and fppd_start
replaced by stand-ins that record their calls, so the real fppd is not
touched.
"""

import os

import pytest

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture


@pytest.mark.skipif(not os.path.exists("/etc/fpp/container"),
                    reason="fppd_restart takes the container branch only in a container")
def test_fppd_restart_clears_the_restart_flag_in_the_media_settings(fppinit):
    """fppd_restart sets restartFlag back to 0 in the settings file of the
    media directory the tree is configured with, then runs fppd_stop and
    fppd_start.

    Regression: cdd3a74a9. The flag was cleared in $FPPHOME/media/settings,
    which is not the media directory when it lives elsewhere (macOS), so the
    "restart needed" banner stayed after a restart.
    """
    fppinit.write("settings", 'restartFlag = "1"\nKioskRotate = "0"\n')
    fppinit.unstub("mount")
    for s in ("fppd_stop", "fppd_start"):
        fppinit.root_file(f"/opt/fpp/scripts/{s}",
                          f"#!/bin/sh\nprintf '%s\\n' \"{s}\" >> /fppinit-calls.log\n")
    r = fppinit._run(["bash", "-c",
                      # The tree's www/media_root.txt names whichever media
                      # directory fppd last ran with; point it at the sandbox's.
                      f"echo {MEDIA} > /tmp/media_root.txt; "
                      "mount --bind /tmp/media_root.txt /opt/fpp/www/media_root.txt; "
                      "bash /opt/fpp/scripts/fppd_restart; echo \"exited $?\""], timeout=60)
    out = r.stdout + r.stderr
    settings = fppinit.media_file("settings")
    assert "exited 0" in out, out[-2000:]
    assert 'restartFlag = "0"' in settings and 'restartFlag = "1"' not in settings, \
        f"restartFlag not cleared:\n{settings}\n{out[-2000:]}"
    assert 'KioskRotate = "0"' in settings, settings
    calls = [c for c in fppinit.calls() if c in ("fppd_stop", "fppd_start")]
    assert calls == ["fppd_stop", "fppd_start"], f"{calls}\n{out[-2000:]}"
