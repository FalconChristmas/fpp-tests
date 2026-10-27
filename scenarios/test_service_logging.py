"""Where the output of FPP's services and service scripts goes: fppinit
writes each line both to fppd.log, prefixed like fppd's own lines, and to
the stdout it was started with -- journald under systemd, a terminal by
hand -- along with the output of everything it runs; fppd_stop's lines are
tagged as a shutdown. fppinit runs in its sandbox (fppinit.py)."""

import os
import re
import subprocess
import time

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture


def test_fppinit_output_reaches_both_its_stdout_and_fppd_log(fppinit):
    """Each line fppinit prints, and each line a script it runs prints (here
    a plugin's preStart.sh), goes to fppinit's own stdout, raw, and to
    fppd.log with fppd's line prefix.

    Regression: b2399250e. teeOutput() had become a line-prefixer that only
    appended to fppd.log: fppinit's output, and that of everything it runs,
    stopped reaching journald, so `systemctl status fppinit` and a hand-run
    `fppinit setupAudio` showed nothing.
    """
    fppinit.write("plugins/fpp-tests-plugin/scripts/preStart.sh",
                  "#!/bin/sh\necho fpp-tests plugin preStart ran\n")
    os.chmod(os.path.join(fppinit.media, "plugins/fpp-tests-plugin/scripts/preStart.sh"), 0o755)
    # The media directory is at /home/fpp/media as well: before e930dec80
    # fppinit took no FPP_MEDIA_DIR and wrote its log there.
    r = fppinit._run(["/opt/fpp/src/fppinit", "runPreStartScripts"], media_home=True)
    assert r.returncode == 0, f"fppinit exited {r.returncode}:\n{(r.stdout + r.stderr)[-3000:]}"
    log = fppinit.media_file("logs/fppd.log") if fppinit.media_exists("logs/fppd.log") else ""
    for line in ("Running FPPINIT runPreStartScripts", "fpp-tests plugin preStart ran"):
        assert re.search(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} fppinit\(\d+\) \[Scripts\] " + line + "$",
                         log, re.M), f"{line!r} isn't in fppd.log with fppd's prefix:\n{log[-2000:]}"
        assert re.search("^" + line + "$", r.stdout, re.M), \
            f"fppinit's stdout lacks {line!r}:\nstdout:\n{r.stdout[-2000:]}\nstderr:\n{r.stderr[-1000:]}"


def test_fppinit_script_actions_log_which_scripts_they_run(fppinit):
    """fppinit runPreStartScripts, run by itself, puts its output in fppd.log
    under the Scripts facility, naming each UserCallbackHook.sh and plugin
    script it starts.

    Regression: c318270ed. Only start, postNetwork, bootPre and bootPost
    sent their output to fppd.log, so the standalone script actions (and
    the network, audio, config and reboot ones) logged nowhere, and nothing
    said which scripts had been run.
    """
    for rel in ("plugins/fpp-tests-plugin/scripts/preStart.sh", "scripts/UserCallbackHook.sh"):
        fppinit.write(rel, "#!/bin/sh\nexit 0\n")
        os.chmod(os.path.join(fppinit.media, rel), 0o755)
    r = fppinit._run(["/opt/fpp/src/fppinit", "runPreStartScripts"], media_home=True)
    assert r.returncode == 0, f"fppinit exited {r.returncode}:\n{(r.stdout + r.stderr)[-3000:]}"
    log = fppinit.media_file("logs/fppd.log") if fppinit.media_exists("logs/fppd.log") else ""
    for line in ("FPP - Running UserCallbackHook.sh preStart",
                 "FPP - Running plugin fpp-tests-plugin script for preStart"):
        assert re.search(r"fppinit\(\d+\) \[Scripts\] " + line + "$", log, re.M), \
            f"{line!r} isn't in fppd.log:\n{log[-2000:]}\nstdout:\n{r.stdout[-1500:]}"


@pytest.mark.skipif(not os.path.exists("/etc/fpp/container"),
                    reason="fppd_stop kills every fppd by name: the device's own under run-local.sh")
def test_fppd_stop_logs_as_a_shutdown(fppd):
    """scripts/fppd_stop's lines in fppd.log carry the Shutdown facility.

    Regression: c318270ed. fppd_stop and fppd_restart opened their log with
    startDaemonLog's default, so a stop read as "[Startup] Stopping fppd".
    """
    from test_crash_reports import private_fppdir
    fppd.start()
    view = private_fppdir(fppd.tree, fppd.media)
    subprocess.run(["bash", os.path.join(view, "scripts", "fppd_stop")], capture_output=True,
                   text=True, timeout=60, stdin=subprocess.DEVNULL,
                   env=dict(os.environ, LD_LIBRARY_PATH=os.path.join(fppd.tree, "src")))
    fppd.proc.wait(timeout=30)
    fppd.exit_expected = True
    log = os.path.join(fppd.media, "logs", "fppd.log")
    # The script's log writer may still be draining after fppd is gone.
    deadline = time.monotonic() + 10
    while "Stopping fppd" not in open(log, errors="replace").read() and time.monotonic() < deadline:
        time.sleep(0.2)
    lines = [l for l in open(log, errors="replace").read().splitlines() if l.endswith("Stopping fppd")]
    assert lines and all("fppd_stop(" in l and "[Shutdown] " in l for l in lines), lines
