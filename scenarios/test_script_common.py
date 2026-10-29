"""Helpers in scripts/common that the config upgrades and the CSP and
proxy scripts call, run as root in the fppinit sandbox (fppinit.py), where
systemctl is a stand-in that answers from the unit states a scenario sets
and records its calls."""

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
