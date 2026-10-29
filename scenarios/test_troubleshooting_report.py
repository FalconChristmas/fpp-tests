"""The Troubleshooting commands' output that a Diagnostic Report carries
(www/troubleshootingText.php --manual-crash-report, which
scripts/generate_crash_report runs and redacts into
logs/troubleshootingCommands.log). It is run here straight from the tree,
the way generate_crash_report runs it, with no web server on the box --
which is when a report is most needed."""

import os
import re
import subprocess

from test_crash_reports import private_fppdir


def troubleshooting_text(fppd):
    view = os.path.join(fppd.media, "tmp", "fppdir")
    if not os.path.isdir(view):
        view = private_fppdir(fppd.tree, fppd.media)
    env = dict(os.environ)
    env.pop("LD_PRELOAD", None)
    # The command list is read from /opt/fpp/www/troubleshoot-commands.json,
    # wherever the tree is; point /opt/fpp at this one for the run.
    linked = not os.path.lexists("/opt/fpp")
    if linked:
        os.makedirs("/opt", exist_ok=True)
        os.symlink(view, "/opt/fpp")
    try:
        # short_open_tag: config.php needs it, and FPP_Install.sh turns it on.
        r = subprocess.run(["php", "-d", "short_open_tag=1", os.path.join(view, "www", "troubleshootingText.php"),
                            "--manual-crash-report"], capture_output=True, text=True, timeout=300, env=env, cwd=fppd.media)
    finally:
        if linked:
            os.unlink("/opt/fpp")
    assert r.returncode == 0, f"rc {r.returncode}:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    return r.stdout


def section(out, title):
    """The output printed under one command's header, up to the next one."""
    m = re.search(r"^Title  : " + re.escape(title) + r"\n(.*?)(?=^Title  : |^=====|\Z)", out, re.S | re.M)
    assert m, f"no '{title}' command in the output:\n{out[:3000]}"
    return m.group(1)


def test_commands_run_in_process_and_get_their_variables(fppd):
    """Each command is run by troubleshootingText.php itself and its output
    printed under it: Kernel Version prints uname -a's line. A command's
    [[name]] placeholders are filled in first: the RTC command reads
    /dev/rtc0 off a Pi or a Beagle without a cape clock, and no command line
    is left with a placeholder in it.

    Regression: dd4228704. Each command was fetched from
    http://localhost/troubleshootingHelper.php, so with no web server
    answering there (or one that refused the request) every command came
    back empty, and the printed command lines still carried their [[...]]
    placeholders, which only the helper filled in.
    """
    out = troubleshooting_text(fppd)
    uname = subprocess.run(["uname", "-a"], capture_output=True, text=True).stdout.strip()
    kernel = section(out, "Kernel Version")
    assert uname in kernel, f"Kernel Version printed no uname -a output:\n{kernel}"
    rtc = section(out, "RTC")
    assert "Command: hwclock -v -r -f /dev/rtc0\n" in rtc, f"the RTC device was not filled in:\n{rtc}"
    left = [l for l in out.splitlines() if l.startswith("Command: ") and "[[" in l]
    assert not left, f"command lines still carry placeholders: {left}"
