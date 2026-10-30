"""On a Pi 5 whose own RTC is enabled, fpprtc and the Troubleshooting RTC
command use the cape's clock, rtc1, not the Pi's rtc0.

Device only: a Pi 5 with its RTC on (DisablePiRTC off, so no dtparam=rtc=off
in config.txt) and a cape clock instantiated as rtc1. It skips anywhere
else. fpprtc's getRTCDev() is compiled from the tree on its own (it is in a
Pi build only) and asked which device it would set up, from the real sysfs;
troubleshootingText.php, which runs the commands for a Diagnostic Report,
prints the RTC command it ran.

Regression: fpp 837f015a4. Newer Pi 5 kernels name the Pi's RTC
"rpi-rtc soc@107c000000:rpi_rtc", where fpprtc looked for "soc:rpi_rtc", so
it set up and read the Pi's battery-less rtc0; the Troubleshooting command
read rtc0 too, having no Pi case at all. (It also made the command
hwclock -v.) Verified red on a Pi 5 against a hand revert of the fix.
"""

import os
import subprocess

import pytest


def pi_rtc_and_cape_clock():
    try:
        with open("/sys/class/rtc/rtc0/name") as f:
            return "rpi_rtc" in f.read() and os.path.exists("/dev/rtc1")
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not pi_rtc_and_cape_clock(),
                                reason="a Pi 5 with its own RTC enabled and a cape clock as rtc1")

HARNESS = """
#define main fpprtc_main
#include "boot/FPPRTC.cpp"
#undef main
int main() { printf("%s\\n", getRTCDev().c_str()); return 0; }
"""


def test_fpprtc_picks_the_cape_clock_over_the_pi5_rtc(tmp_path):
    src = os.path.join(os.environ["FPP_TREE"], "src")
    (tmp_path / "harness.cpp").write_text(HARNESS)
    exe = str(tmp_path / "harness")
    subprocess.run(["g++", "-std=c++20", "-DPLATFORM_PI", "-I", src, "-I/usr/include/jsoncpp", "-o", exe,
                    str(tmp_path / "harness.cpp"), os.path.join(src, "common_mini.cpp")],
                   check=True, capture_output=True, text=True)
    out = subprocess.run([exe], capture_output=True, text=True, check=True).stdout.strip()
    assert out == "/dev/rtc1", f"fpprtc would set up {out}, the Pi's own RTC"


def test_troubleshooting_rtc_command_reads_the_cape_clock():
    www = os.path.join(os.environ["FPP_TREE"], "www")
    env = dict(os.environ)
    env.pop("LD_PRELOAD", None)
    r = subprocess.run(["php", "-d", "short_open_tag=1", "troubleshootingText.php"], cwd=www,
                       capture_output=True, text=True, timeout=300, env=env)
    lines = [l for l in r.stdout.splitlines() if l.startswith("Command: hwclock")]
    assert lines, f"no RTC command in the output (rc {r.returncode}):\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    assert lines[0] == "Command: hwclock -v -r -f /dev/rtc1", lines
    assert "Waiting in loop for time from /dev/rtc1" in r.stdout or "Time read from Hardware Clock" in r.stdout, \
        r.stdout[-2000:]
