"""Upgrade 138 pushes the Apache site that turns off php-fpm connection
reuse, and leaves it to a reboot to take effect.

The step runs inside the upgrade request Apache is serving, so reloading
Apache or php-fpm from it cuts the connection the upgrade's own output is
streaming over.
"""

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_upgrade_steps import media_settings, step


def test_upgrade_138_pushes_the_site_and_asks_for_a_reboot_without_reloading(fppinit):
    """Regression: e113c2fc5. The step reloaded Apache and php-fpm after
    copying the site, which dropped the connection the update's output was
    streaming over and hung the update. It now sets the reboot flag.

    Also 2b0feb2d8 (the step itself): an existing box kept the old site
    file, so the new one is copied over it."""
    fppinit.write("settings", "")
    fppinit.service("apache2", active=True)
    fppinit.root_file("/etc/apache2/sites-enabled/000-default.conf", "# a stale site\n")
    r = fppinit._run(["sh", "-c", "/opt/fpp/upgrade/138/upgrade.sh; echo \"exited $?\"; "
                                  "cmp /opt/fpp/etc/apache2.site /etc/apache2/sites-enabled/000-default.conf "
                                  "&& echo site-current"], timeout=120, media_home=True)
    out = r.stdout + r.stderr
    assert "site-current" in out, f"the Apache site is not the tree's:\n{out[-3000:]}"
    assert "exited 0" in out, out[-3000:]
    calls = [c for c in fppinit.calls() if "apache" in c or "fpm" in c or "reload" in c or "restart" in c]
    assert not calls, f"the step reloaded or restarted a web service: {calls}"
    assert media_settings(fppinit).get("rebootFlag") == "1", f"no reboot asked for:\n{out[-3000:]}"
