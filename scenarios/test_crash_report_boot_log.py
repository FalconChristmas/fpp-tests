"""A level-3 crash report's tmp/boot.log gives the kernel log with
wall-clock times, so its lines can be set beside fppd.log's.

The container can't read the kernel log, so dmesg is a stand-in that prints
timestamps the way util-linux's does: seconds since boot, or the date and
time with -T (as the real one does on a Pi 5).

Regression: fpp fa6944547. fppd's crash handler wrote plain dmesg into
tmp/boot.log; it became dmesg -T. The handler's report-building moved into
scripts/generate_crash_report (fec15ca35), which fppd runs on a crash, and
the -T with it; this runs that script as test_crash_reports.py does.

Also c1b60cd58: fppd's handler added the fppinit, fppoled and
fpp_postnetwork journal to tmp/boot.log; the script keeps it, and the
journalctl stand-in's line must be in the log.
"""

import os
import subprocess
import zipfile

from test_crash_reports import private_fppdir

WALL = "[Thu Oct 22 11:20:53 2026] Booting Linux on physical CPU 0x0000000000"
MONO = "[    0.000000] Booting Linux on physical CPU 0x0000000000"


def test_crash_report_boot_log_has_wall_clock_kernel_times(fppd, tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "dmesg").write_text(f"""#!/bin/sh
case "$1" in
-T) echo '{WALL}' ;;
"") echo '{MONO}' ;;
*) echo "dmesg: invalid option -- '$1'" >&2; exit 1 ;;
esac
""")
    (bin_dir / "journalctl").write_text("#!/bin/sh\necho 'fppinit: boot done'\n")
    for tool in ("dmesg", "journalctl"):
        (bin_dir / tool).chmod(0o755)
    os.makedirs(os.path.join(fppd.media, "crashes"), exist_ok=True)
    view = private_fppdir(fppd.tree, fppd.media)
    out = os.path.join(fppd.media, "crashes", "report.zip")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}")
    env.pop("LD_PRELOAD", None)
    r = subprocess.run(["bash", os.path.join(view, "scripts", "generate_crash_report"), "3", out],
                       capture_output=True, text=True, timeout=180, env=env)
    assert r.returncode == 0 and os.path.exists(out), f"no report:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    with zipfile.ZipFile(out) as z:
        logs = [z.read(n).decode("latin-1") for n in z.namelist() if n.endswith("tmp/boot.log")]
    assert logs, "no tmp/boot.log in a level-3 report"
    boot = logs[0]
    assert "fppinit: boot done" in boot, f"the boot log lost the fppinit journal:\n{boot}"
    assert WALL in boot, f"the kernel log has no wall-clock times:\n{boot}"
    assert MONO not in boot, boot
