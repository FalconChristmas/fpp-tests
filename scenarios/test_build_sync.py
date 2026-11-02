"""The build scripts flush what the linker wrote before anything restarts
fppd or the box loses power: a build that finishes with its binaries only
in the page cache can leave them zero-filled after a power cut.

make, sudo and sync are stand-ins that record their calls in order, so the
test sees that a sync comes after the last make.
"""

import pytest

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_build_scripts import RECORDING, RECORDING_MAKE, RECORDING_SUDO


def stub_build_tools(sb):
    sb.unstub("mount")
    sb.root_file("/usr/bin/sudo", RECORDING_SUDO)
    sb.root_file("/usr/bin/make", RECORDING_MAKE)
    sb.root_file("/usr/bin/pgrep", '#!/bin/sh\ncase "$*" in *fppd*) echo 4242 ;; *) exit 1 ;; esac\n')
    for d in ("/usr/bin", "/bin"):
        sb.root_file(f"{d}/sync", RECORDING)


def assert_synced_after_build(calls, what):
    makes = [i for i, c in enumerate(calls) if c.startswith(("make ", "sudo make ", "sudo -u"))]
    syncs = [i for i, c in enumerate(calls) if c.strip() == "sync"]
    assert makes, f"{what} ran no build: {calls}"
    assert syncs, f"{what} never flushed the new binaries to disk: {calls}"
    assert syncs[-1] > makes[-1], f"{what} synced before its last make finished: {calls}"


def test_compileBinaries_syncs_after_the_build(fppinit):
    """Regression: db73baa32. compileBinaries (git_pull, upgrade_FPP,
    git_branch) returned with the new fppd and libraries only in the page
    cache; a power loss before writeback left them zero-filled and fppd
    failed every boot with "Exec format error"."""
    stub_build_tools(fppinit)
    r = fppinit._run(["bash", "-c",
                      f"echo {MEDIA} > /tmp/media_root.txt && "
                      "mount --bind /tmp/media_root.txt /opt/fpp/www/media_root.txt && "
                      "export FPPDIR=/opt/fpp && . /opt/fpp/scripts/common && . /opt/fpp/scripts/functions && "
                      "compileBinaries; echo \"compileBinaries exited $?\""], timeout=120)
    out = r.stdout + r.stderr
    assert "compileBinaries exited 0" in out, out[-3000:]
    assert_synced_after_build([c for c in fppinit.calls() if not c.startswith(("systemctl", "pgrep"))],
                              "compileBinaries")


def test_fpp_build_syncs_after_the_build_and_keeps_its_status(fppinit):
    """Regression: db73baa32, for scripts/fpp_build, which runs make
    directly. The sync must not replace make's exit status."""
    stub_build_tools(fppinit)
    r = fppinit._run(["bash", "-c",
                      f"echo {MEDIA} > /tmp/media_root.txt && "
                      "mount --bind /tmp/media_root.txt /opt/fpp/www/media_root.txt && "
                      "FPPDIR=/opt/fpp /opt/fpp/scripts/fpp_build; echo \"fpp_build exited $?\""], timeout=120)
    out = r.stdout + r.stderr
    assert "fpp_build exited 0" in out, out[-3000:]
    assert_synced_after_build([c for c in fppinit.calls() if not c.startswith(("systemctl", "pgrep"))],
                              "fpp_build")
