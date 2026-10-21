"""scripts/pipewire_diagnostics.sh, the Troubleshooting page's PipeWire
health checks, run as root in the fppinit sandbox (fppinit.py) so nothing
it does reaches the machine."""

from fppinit import fppinit  # noqa: F401 -- the fixture


def test_a_temp_dir_it_cannot_make_does_not_cost_tmp(fppinit):
    """When the diagnostics can't make their temp directory (here /tmp has
    no inodes left), they fail with a message and leave /tmp alone.

    Regression: 475eb920b. A failed mktemp fell back to /tmp itself as the
    temp directory, and the exit trap ran rm -rf on it: every file in /tmp
    went, as root."""
    # The sandbox's mount is a stub that records its calls, so /tmp is
    # remounted through libc.
    script = r"""
python3 -c 'import ctypes, sys; sys.exit(ctypes.CDLL(None, use_errno=True).mount(b"tmpfs", b"/tmp", b"tmpfs", 0, b"size=1m,nr_inodes=3"))' || exit 90
touch /tmp/keep || exit 91
i=0
while touch /tmp/fill$i 2>/dev/null; do
    i=$((i + 1)); [ $i -gt 50 ] && exit 92
done
mkdir /tmp/probe 2>/dev/null && exit 93
/opt/fpp/scripts/pipewire_diagnostics.sh no-such-section
echo "diagnostics exited $?"
ls /tmp
"""
    r = fppinit._run(["sh", "-c", script], timeout=60)
    out = r.stdout + r.stderr
    assert r.returncode == 0, f"could not fill /tmp (setup step {r.returncode}):\n{out[-2000:]}"
    assert "diagnostics exited" in out, out[-2000:]
    listing = out.split("diagnostics exited", 1)[1].split()
    assert "keep" in listing, f"the diagnostics emptied /tmp:\n{out[-2000:]}"
    assert "cannot create temp directory" in out, out[-2000:]
