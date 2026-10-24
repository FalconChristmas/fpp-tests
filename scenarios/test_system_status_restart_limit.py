"""api/system/status's restart-limit check (GetFPPDRestartBlocked() in
www/api/controllers/system.php), run from the tree under test with php-cli
against a real fppd: the receiving end of the web suite's
web/tests/system-status-forks.spec.ts.

The function is taken out of the tree's system.php as it is and run on its
own (the rest of the controller needs Apache and the media directory). A
stand-in systemctl first on PATH answers for a unit held back by systemd's
start limit and logs its arguments, each checked against the real systemctl's
syntax.
"""

import json
import os
import subprocess
import tempfile

DRIVER = r"""<?php
$src = file_get_contents(getenv('FPP_TREE') . '/www/api/controllers/system.php');
if (!preg_match('/^function GetFPPDRestartBlocked\(\).*?^}/ms', $src, $m)) {
    fwrite(STDERR, "GetFPPDRestartBlocked() not found\n");
    exit(2);
}
eval($m[0]);
$n = intval($argv[1] ?? 1);
for ($i = 0; $i < $n; $i++) {
    $r = GetFPPDRestartBlocked();
}
echo json_encode($r);
"""

# What systemctl prints for an fppd the start limit stopped a minute ago.
STUB = r"""#!/bin/sh
echo "$*" >> "$FPP_TESTS_SYSTEMCTL_LOG"
case "$*" in
  "show fppd --property=ActiveState --value") echo failed ;;
  "show fppd --property=Result --value") echo start-limit-hit ;;
  "status fppd") printf 'x fppd.service - FPP Daemon\n     Active: failed (Result: start-limit-hit)\nsystemd[1]: fppd.service: Start request repeated too quickly.\n' ;;
  "show fppd --property=StartLimitIntervalSec --value") echo 200000000 ;;
  "show fppd --property=InactiveEnterTimestamp --value") date -d '1 minute ago' '+%a %Y-%m-%d %H:%M:%S %Z' ;;
  *) ;;
esac
"""

# The real systemctl's forms for these: "systemctl show [UNIT...]
# --property=NAME --value" and "systemctl status [UNIT...]".
REAL = [
    "show fppd --property=ActiveState --value",
    "show fppd --property=Result --value",
    "status fppd",
    "show fppd --property=StartLimitIntervalSec --value",
    "show --property=StartLimitIntervalSec --value",
    "show fppd --property=InactiveEnterTimestamp --value",
    "show fppd --property=InactiveEnterTimestampMonotonic --value",
]


def run_check(times=1):
    with tempfile.TemporaryDirectory() as d:
        stub = os.path.join(d, "systemctl")
        with open(stub, "w") as f:
            f.write(STUB)
        os.chmod(stub, 0o755)
        driver = os.path.join(d, "driver.php")
        with open(driver, "w") as f:
            f.write(DRIVER)
        log = os.path.join(d, "calls.log")
        open(log, "w").close()
        env = dict(os.environ, PATH=d + ":" + os.environ["PATH"], FPP_TESTS_SYSTEMCTL_LOG=log)
        out = subprocess.run(["php", driver, str(times)], env=env, capture_output=True, text=True, timeout=60)
        assert out.returncode == 0, out.stderr
        with open(log) as f:
            calls = [l.strip() for l in f if l.strip()]
        return json.loads(out.stdout), calls


def test_a_running_fppd_is_never_reported_held_back_and_no_systemctl_runs(fppd):
    """With fppd up, the check answers from a connection to fppd's API port
    alone: not blocked, and no systemctl at all. fppd takes the bare
    connect-and-close the check makes on every status poll -- a hundred of them
    here -- and still answers.

    Regression: 80746b5ed. Every status poll forked `which systemctl` and two
    `systemctl show fppd`, though an fppd that accepts a connection on its API
    port can't be held back by the restart limit."""
    fppd.start()
    result, calls = run_check(times=100)
    assert result == {"blocked": False}, result
    assert calls == [], calls
    fppd.check_alive()
    assert fppd.get("/fppd/status")["status_name"], "fppd stopped answering"


def test_a_dead_fppd_held_back_by_the_start_limit_is_reported_blocked(fppd):
    """With no fppd on the port, the systemctl path still runs and reports the
    restart limit, with the time left in its window, and every systemctl call
    is one the real systemctl accepts.

    Receiving end of 80746b5ed, whose fix only skips this path while fppd is
    up: it passes on the parent too (the other test is the red half)."""
    result, calls = run_check()
    assert result["blocked"] is True, result
    assert result["intervalSec"] == 200, result
    assert 0 < result["remainingSec"] <= 140, result
    assert calls, "the stand-in systemctl was never run"
    assert [c for c in calls if c not in REAL] == [], calls
