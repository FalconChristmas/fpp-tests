"""The logrotate configs the tree installs (etc/logrotate.d), exercised with
logrotate's debug mode against a scratch logs directory: which files they
would rotate."""

import os
import shutil
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")


def considered(tmp_path, config, names):
    """The log files `logrotate -d` reports considering for the config, with
    its glob pointed at a directory holding `names`."""
    if not shutil.which("logrotate"):
        pytest.skip("logrotate is not installed")
    logs = tmp_path / "logs"
    logs.mkdir()
    for n in names:
        (logs / n).write_text("x" * 100)
    text = open(os.path.join(TREE, "etc", "logrotate.d", config)).read()
    text = text.replace("/home/fpp/media/logs", str(logs))
    # no fpp user here, and nothing to be run as it
    text = "\n".join(l for l in text.splitlines() if not l.strip().startswith(("su ", "create ")))
    cfg = tmp_path / "rotate.conf"
    cfg.write_text(text)
    r = subprocess.run(["logrotate", "-d", "-s", str(tmp_path / "state"), str(cfg)],
                       capture_output=True, text=True, timeout=30)
    out = r.stdout + r.stderr
    return sorted(os.path.basename(l.split("considering log", 1)[1].strip())
                  for l in out.splitlines() if "considering log" in l)


def test_the_other_logs_config_covers_logs_with_an_underscore_in_the_name(tmp_path):
    """fpp_other_logs rotates every *.log in the logs directory that does not
    start with "a" (fppd.log, apache's and the rest have configs of their
    own), including those whose names start with an underscore.

    Regression: 4780ff6fd. The name pattern left out "_", so such logs
    grew without limit."""
    got = considered(tmp_path, "fpp_other_logs", ["_plugin.log", "other.log", "apache2-error.log", "Upper.log", "notalog.txt"])
    assert got == ["Upper.log", "_plugin.log", "other.log"], got
