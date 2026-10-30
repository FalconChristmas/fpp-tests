"""Helpers in scripts/common that the config upgrades and the CSP and
proxy scripts call, run as root in the fppinit sandbox (fppinit.py), where
systemctl is a stand-in that answers from the unit states a scenario sets
and records its calls; and calling common as a command, and sourcing common
and functions, run straight from the tree."""

import os
import subprocess

from fppinit import fppinit  # noqa: F401 -- the fixture


def reload_apache(sb, active):
    sb.service("apache2", active=active)
    r = sb._run(["bash", "-c", "export FPPDIR=/opt/fpp; . /opt/fpp/scripts/common; "
                 "gracefullyReloadApacheConf; echo \"returned $?\""])
    return r.stdout + r.stderr, [c for c in sb.calls() if c.startswith("systemctl")]


def test_apache_is_reloaded_only_when_it_is_running(fppinit):
    """gracefullyReloadApacheConf reloads a running Apache and leaves one
    that isn't running alone, saying so: systemd refuses to reload a unit
    that isn't active ("apache2.service is not active, cannot reload"), and
    an image build or a container has no running Apache to reload.

    Regression: 16b070966. It ran "systemctl reload apache2" whatever
    Apache's state, so on a stopped Apache every config upgrade and CSP
    change that ended with a reload failed on systemd's refusal.
    """
    out, calls = reload_apache(fppinit, active=True)
    assert "systemctl reload apache2" in calls, f"{calls}\n{out[-2000:]}"
    assert "returned 0" in out, out[-2000:]

    out, calls = reload_apache(fppinit, active=False)
    assert "systemctl reload apache2" not in calls, f"reloaded a stopped Apache: {calls}"
    assert "Apache is not running" in out, out[-2000:]


def test_common_runs_a_helper_named_on_its_command_line(fppd, tmp_path):
    """scripts/common run as a command calls the helper named by its
    arguments (`scripts/common setSetting Key Value`); common and functions
    do nothing of the kind when another script sources them with arguments
    of its own, or a login shell (whose $0 is "-bash") sources them.
    functions is a library, only ever sourced: nothing runs it.

    Regression: 88b1606d7. There was no way to call a helper directly.
    Regression: f4d30c4e8 (#1768). Any script sourcing them ran its own
    arguments as a command ("command not found").
    Regression: 463a89663. With $0 "-bash", basename took it for an option
    and printed an error on every ssh login.
    Regression: 0677fb44c. f4d30c4e8 left a debug "BASENAME: ..." line that
    every source printed."""
    fppd.start()  # writes the media_root.txt the scripts find the media directory by
    env = dict(os.environ, FPPDIR=fppd.tree)
    scripts = os.path.join(fppd.tree, "scripts")

    def run(argv):
        r = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60)
        return r.stdout, r.stdout + r.stderr

    _, out = run([os.path.join(scripts, "common"), "setSetting", "fppTestsDirect", "fromTheCommandLine"])
    with open(os.path.join(fppd.media, "settings")) as f:
        assert "fromTheCommandLine" in f.read(), f"scripts/common setSetting did nothing:\n{out[-2000:]}"

    for helper in ("common", "functions"):
        sourcer = tmp_path / f"source-{helper}.sh"
        sourcer.write_text(f'. "{scripts}/{helper}"\necho sourced\n')
        stdout, out = run(["bash", str(sourcer), "echo", "LEAKED-ARGUMENT"])
        assert "sourced" in stdout, f"sourcing {helper} failed:\n{out[-2000:]}"
        assert "LEAKED-ARGUMENT" not in out, f"sourcing {helper} ran the script's arguments:\n{out[-2000:]}"

        stdout, out = run(["bash", "-c", f'. "{scripts}/{helper}"; echo sourced', "-bash"])
        assert "sourced" in stdout, f"sourcing {helper} as a login shell failed:\n{out[-2000:]}"
        assert "basename" not in out.lower(), f"sourcing {helper} as a login shell printed:\n{out[-2000:]}"
