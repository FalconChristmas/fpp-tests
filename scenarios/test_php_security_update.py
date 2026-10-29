"""scripts/php_security_update and upgrade 160, which install the
distribution's fixed PHP without waiting for an OS update, run as root in the
fppinit sandbox (fppinit.py).

The installed packages are what a dpkg-query stand-in lists, and apt-get is a
stand-in that "upgrades" them by changing that list.  While it installs, it
does what the php8.x packages' maintainer scripts do on an upgrade: restart
their services through the real deb-systemd-invoke and invoke-rc.d, which ask
/usr/sbin/policy-rc.d first.  Those, and the real dpkg --compare-versions, are
the receiving ends: whether the php-fpm restart is refused while Apache's is
not, and how a version compares, is theirs to say, not the script's.

Regression: a0aa04d3e ("install the PHP2Shell fix without waiting for an OS
update"), which added both.  A git update never touched OS packages, so only
a new image or fppos brought the fixed PHP.  (Proved red with the script and
the upgrade removed on master; the php-fpm restart check was also shown red
with the script's policy-rc.d left out.)
"""

import os

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_system_scripts import fppdir_view

STATUS = "tmp/dpkg-status"           # what dpkg-query lists, in the media dir
UPGRADED = "tmp/dpkg-status-after"   # what the apt sources would upgrade it to
APT_LOG = "tmp/apt.log"
TIMER = "fpp-php-security-update.timer"

# ${db:Status-Abbrev} ${Package} ${source:Package} ${Version}, as the script asks.
VULNERABLE = ("ii  php8.4-fpm php8.4 8.4.20-1~deb13u1\n"
              "ii  php8.4-cli php8.4 8.4.20-1~deb13u1\n"
              "ii  php-common php-defaults 2:96\n")
FIXED = VULNERABLE.replace("8.4.20-1~deb13u1", "8.4.27-1~deb13u1")

DPKG_QUERY = f"#!/bin/sh\ncat {MEDIA}/{STATUS}\n"

APT_GET = f"""#!/bin/sh
printf '%s\\n' "apt-get $*" >> /fppinit-calls.log
case " $* " in
  *" install "*)
    # The packages' maintainer scripts restart their services on an upgrade.
    mkdir -p /run/systemd/system
    for unit in php8.4-fpm apache2; do
        deb-systemd-invoke restart $unit.service >> {MEDIA}/{APT_LOG} 2>&1
        invoke-rc.d --query $unit restart > /dev/null 2>&1
        echo "query $unit $?" >> {MEDIA}/{APT_LOG}
    done
    if [ -f {MEDIA}/{UPGRADED} ]; then cp {MEDIA}/{UPGRADED} {MEDIA}/{STATUS}; fi
    ;;
esac
exit 0
"""


def setup(sb, installed, upgraded=None, policy=None):
    sb.write(STATUS, installed)
    if upgraded is not None:
        sb.write(UPGRADED, upgraded)
    sb.write(APT_LOG, "")
    sb.settings(fppMode="player")
    sb.unstub("dpkg")      # the real dpkg --compare-versions
    sb.unstub("apt-get")
    sb.root_file("/usr/bin/dpkg-query", DPKG_QUERY)
    sb.root_file("/usr/bin/apt-get", APT_GET)
    sb.root_file("/usr/sbin/policy-rc.d", policy)  # the image's own one, or none
    for unit in ("php8.4-fpm", "apache2"):
        sb.root_file(f"/etc/init.d/{unit}", "#!/bin/sh\nexit 0\n")
        # Running and enabled, so a restart the policy allows does happen.
        sb.service(unit, enabled=True, active=True)
    return fppdir_view(sb)


def reboot_flag(sb):
    return 'rebootFlag = "1"' in sb.media_file("settings")


def test_check_compares_the_upstream_release(fppinit):
    """--check: 2 while any php8.x package is older than its branch's fixed
    release, 0 at or past it, a Raspbian rebuild's +rpi1 suffix included."""
    view = setup(fppinit, VULNERABLE)
    r = fppinit._run([f"{view}/scripts/php_security_update", "--check"])
    assert r.returncode == 2, r.stdout + r.stderr
    assert "php8.4-fpm 8.4.20-1~deb13u1 is older than the fixed 8.4.27" in r.stdout, r.stdout
    assert not [c for c in fppinit.calls() if c.startswith("apt-get")], fppinit.calls()

    fppinit.write(STATUS, FIXED.replace("~deb13u1", "~deb13u1+rpi1"))
    r = fppinit._run([f"{view}/scripts/php_security_update", "--check"])
    assert r.returncode == 0, r.stdout + r.stderr


def test_upgrade_installs_php_without_restarting_php_fpm(fppinit):
    """Upgrading the installed php8.x packages: php-fpm's restart is refused
    while apt runs (the FPP update that started this runs inside php-fpm's
    cgroup), Apache's is not, the policy is gone afterwards, and the reboot
    flag is set for the new PHP to run."""
    view = setup(fppinit, VULNERABLE, upgraded=FIXED)
    r = fppinit._run([f"{view}/scripts/php_security_update"])
    out = r.stdout + r.stderr
    assert r.returncode == 0, out[-3000:]
    apt = [c for c in fppinit.calls() if c.startswith("apt-get")]
    assert any(" update" in c for c in apt), apt
    install = [c for c in apt if " install " in c]
    assert install and "--only-upgrade" in install[0] and "php8.4-fpm php8.4-cli" in install[0], apt
    assert "php-common" not in install[0], "a package not built from php8.x was upgraded"

    log = fppinit.media_file(APT_LOG)
    systemctl = [c for c in fppinit.calls() if c.startswith("systemctl")]
    assert "query php8.4-fpm 101" in log, f"invoke-rc.d would restart php-fpm:\n{log}"
    assert not [c for c in systemctl if "restart" in c and "php8.4-fpm" in c], f"php-fpm was restarted: {systemctl}\n{log}"
    assert "query apache2 104" in log, f"other services were held back too:\n{log}"
    assert any("restart" in c and "apache2.service" in c for c in systemctl), f"{systemctl}\n{log}"
    assert fppinit.written("/usr/sbin/policy-rc.d") is None, "policy-rc.d was left behind"
    assert reboot_flag(fppinit), "no reboot flag for the new PHP"
    assert "PHP upgraded" in r.stdout, r.stdout


def test_timer_retries_until_the_sources_carry_the_fix_then_stops(fppinit):
    """--timer: sources without the fix exit 2 (the unit takes it as success,
    to try again) and leave the timer on; once PHP is fixed the timer turns
    itself off."""
    view = setup(fppinit, VULNERABLE, upgraded=VULNERABLE)
    r = fppinit._run([f"{view}/scripts/php_security_update", "--timer"])
    assert r.returncode == 2, r.stdout + r.stderr
    assert "do not carry the fixed PHP yet" in r.stdout, r.stdout
    assert not [c for c in fppinit.calls() if c.startswith("systemctl disable")], fppinit.calls()
    assert not reboot_flag(fppinit), "nothing was upgraded, but a reboot was asked for"

    fppinit.write(STATUS, FIXED)
    r = fppinit._run([f"{view}/scripts/php_security_update", "--timer"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert f"systemctl disable --now {TIMER}" in fppinit.calls(), fppinit.calls()
    assert not [c for c in fppinit.calls() if c.startswith("apt-get")], "apt ran for a fixed PHP"


def test_someone_elses_policy_is_left_alone(fppinit):
    """An existing policy-rc.d is not replaced or removed, and nothing is
    upgraded: replacing it could start services it holds back."""
    theirs = "#!/bin/sh\n# someone else's\nexit 101\n"
    view = setup(fppinit, VULNERABLE, upgraded=FIXED, policy=theirs)
    r = fppinit._run([f"{view}/scripts/php_security_update"])
    assert r.returncode == 1, r.stdout + r.stderr
    assert "already exists" in r.stdout, r.stdout
    assert fppinit.written("/usr/sbin/policy-rc.d") in (None, theirs), "their policy was changed"
    assert not [c for c in fppinit.calls() if c.startswith("apt-get")], fppinit.calls()


def test_upgrade_160_turns_off_upload_progress_and_arms_the_retry_timer(fppinit):
    """Upgrade 160 adds PHP's own CVE-2026-109619 workaround to the php-fpm
    pool (once), and where the sources don't have the fix yet enables the
    retry timer, with its units copied into place."""
    view = setup(fppinit, VULNERABLE, upgraded=VULNERABLE)
    pool = "/etc/php/8.4/fpm/pool.d/www.conf"
    fppinit.root_file(pool, "[www]\nuser = fpp\n")
    fppinit.root_file("/etc/fpp/container", None)  # 160 skips in a container
    r = fppinit._run([f"{view}/upgrade/160/upgrade.sh"])
    out = r.stdout + r.stderr
    assert r.returncode == 0, out[-3000:]
    conf = fppinit.written(pool) or ""
    assert conf.count("php_admin_value[session.upload_progress.enabled] = 0") == 1, conf
    # /lib is /usr/lib on trixie; the overlay records the real path.
    assert fppinit.written(f"/usr/lib/systemd/system/{TIMER}") is not None, out[-3000:]
    assert fppinit.written("/usr/lib/systemd/system/fpp-php-security-update.service") is not None
    assert f"systemctl enable --now {TIMER}" in fppinit.calls(), fppinit.calls()

    # Run again on a pool that already has it: added once.
    fppinit.root_file(pool, conf)
    r = fppinit._run([f"{view}/upgrade/160/upgrade.sh"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert (fppinit.written(pool) or conf).count("session.upload_progress.enabled") == 1
