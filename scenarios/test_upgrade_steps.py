"""Config upgrade steps (upgrade/<n>/upgrade.sh) and the upgrade_config
loop that runs them, in the fppinit sandbox (fppinit.py): what each step
changes in /etc, the boot directory and the settings, and which commands
it would run.

A step is run directly, as upgrade_config runs it. The media directory is
also mounted at /home/fpp/media, where scripts/common finds it from an
upgrade step's own path.
"""

import os
import re
import shutil
import stat

import pytest

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture

TREE = os.environ.get("FPP_TREE", "")


def fpp_user(sb):
    """The fpp user's uid in the sandbox. The scenario image has no fpp
    user (a device does), so later runs get the image's passwd and group
    with one added at the first free uid from 1000."""
    with open("/etc/passwd") as f:
        passwd = f.read()
    with open("/etc/group") as f:
        group = f.read()
    m = re.search(r"^fpp:[^:]*:(\d+):", passwd, re.M)
    if m:
        return int(m.group(1))
    taken = {int(l.split(":")[2]) for l in passwd.splitlines() + group.splitlines() if l.count(":") >= 2}
    uid = next(u for u in range(1000, 60000) if u not in taken)
    sb.root_file("/etc/passwd", passwd + f"fpp:x:{uid}:{uid}:FPP:/home/fpp:/bin/bash\n")
    sb.root_file("/etc/group", group + f"fpp:x:{uid}:\n")
    return uid


def media_settings(sb):
    out = {}
    if not sb.media_exists("settings"):
        return out
    for line in sb.media_file("settings").splitlines():
        k, sep, v = line.partition("=")
        if sep:
            out[k.strip()] = v.strip().strip('"')
    return out


def step(sb, n, timeout=120):
    if not sb.media_exists("settings"):
        sb.write("settings", "")
    r = sb._run([f"/opt/fpp/upgrade/{n}/upgrade.sh"], timeout=timeout, media_home=True)
    return r, r.stdout + r.stderr


def boot_write(sb, rel, content=""):
    path = os.path.join(sb.boot, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def boot_mkdir(sb, rel):
    os.makedirs(os.path.join(sb.boot, rel), exist_ok=True)


def upper_isdir(sb, path):
    return os.path.isdir(os.path.join(sb.upper, path.lstrip("/")))


# --- upgrade_config ---------------------------------------------------------

def fake_upgrades(sb, versions):
    """An FPPDIR whose upgrade/<n>/upgrade.sh only says it ran."""
    for n in versions:
        sb.write(f"tmp/fakefpp/upgrade/{n}/upgrade.sh", f"#!/bin/sh\necho migration-{n}-ran\n")
        os.chmod(os.path.join(sb.media, "tmp", "fakefpp", "upgrade", str(n), "upgrade.sh"), 0o755)


def upgrade_config(sb, version_file):
    sb.write("tmp/cv", version_file)
    r = sb._run(["env", f"FPPDIR={MEDIA}/tmp/fakefpp", f"CFGVERSIONFILE={MEDIA}/tmp/cv",
                 "/opt/fpp/scripts/upgrade_config", "-notee"])
    out = r.stdout + r.stderr
    ran = sorted(int(l.split("-")[1]) for l in out.splitlines() if l.startswith("migration-"))
    return r, out, ran


def test_upgrade_config_reads_a_padded_or_whitespace_wrapped_version(fppinit):
    """A config version file holding "008", or " 7 " with a CRLF from a
    hand edit, is read as 8 and 7, and the migrations after it run.

    Regression: 42d58b0ab. 37e04c118's check rejected both as corrupt (on
    the mistaken belief that [ -gt ] reads a leading zero as octal), so
    every migration was skipped -- on files that had migrated fine before.
    """
    fake_upgrades(fppinit, range(1, 10))
    r, out, ran = upgrade_config(fppinit, "008\n")
    assert ran == [9], f"ran {ran} from version 008:\n{out[-3000:]}"
    assert fppinit.media_file("tmp/cv").strip() == "9", out[-3000:]

    r, out, ran = upgrade_config(fppinit, " 7 \r\n")
    assert ran == [8, 9], f"ran {ran} from version ' 7 \\r':\n{out[-3000:]}"
    assert fppinit.media_file("tmp/cv").strip() == "9", out[-3000:]


def test_upgrade_config_runs_nothing_for_a_corrupt_version(fppinit):
    """A version file that is not one number -- letters, or two lines --
    runs no migration (running them blind could redo or skip any of them),
    says why, and leaves the file for someone to fix.

    Also covers 37e04c118, whose rule this is; before it the compare
    errored once per loop iteration and skipped every migration silently.
    (Coverage only: both sides of 37e04c118 run nothing.)
    """
    fake_upgrades(fppinit, range(1, 10))
    for bad in ("abc\n", "3\n4\n"):
        r, out, ran = upgrade_config(fppinit, bad)
        assert ran == [], f"ran {ran} from a version file of {bad!r}:\n{out[-3000:]}"
        assert "invalid config version" in out, out[-3000:]
        assert fppinit.media_file("tmp/cv") == bad


def test_every_upgrade_step_is_executable():
    """upgrade_config runs each step as ./upgrade.sh, so a step committed
    without its executable bit fails, and every later step waits behind it.

    Regression: 8c8a1b6ed. Upgrade 147 was committed 644: "Permission
    denied", and upgrade_config stopped at 146 on every box.
    Also 2b48c3c6b and f5928c01f, which set the bit on 93 and 94 after
    they were committed without it.
    """
    up = os.path.join(TREE, "upgrade")
    steps = [d for d in os.listdir(up) if d.isdigit() and os.path.exists(os.path.join(up, d, "upgrade.sh"))]
    assert len(steps) > 50, f"found only {len(steps)} upgrade steps in {up}"
    bad = sorted(int(d) for d in steps
                 if not os.stat(os.path.join(up, d, "upgrade.sh")).st_mode & stat.S_IXUSR)
    assert not bad, f"upgrade steps without an executable bit: {bad}"


UNITS = "/usr/lib/systemd/system"


# --- 144 and 150: the BeagleBone Black's kernel ----------------------------

def bbb_kernels(sb, booted="6.18.52-bone54"):
    """A BBB with FPP kernels 7.1.6-fpp16 (complete) and -fpp17 (no DTBs),
    plus the stock bone kernel, booting `booted`."""
    sb.root_file("/etc/fpp/platform", "BeagleBone Black\n")
    boot_write(sb, "uEnv.txt", f"uname_r={booted}\ncmdline=coherent_pool=1M quiet\n")
    for kv in ("7.1.6-fpp16", "7.1.6-fpp17", "6.18.52-bone54"):
        boot_write(sb, f"vmlinuz-{kv}", "kernel")
        sb.root_file(f"/lib/modules/{kv}/modules.dep", "")
    boot_mkdir(sb, "dtbs/7.1.6-fpp16")
    boot_mkdir(sb, "dtbs/6.18.52-bone54")


def uenv(sb):
    return sb.boot_file("uEnv.txt")


def test_upgrade_144_repoints_a_bbb_at_its_newest_complete_fpp_kernel(fppinit):
    """Upgrade 144 points a BeagleBone Black's uEnv.txt at the newest FPP
    7.1 kernel it has in full (modules and DTBs), keeps every other line,
    and flags a reboot rather than rebooting; again it changes nothing,
    and a BeagleBone 64 is left alone.

    Regression: 10ad24eb5. The 10.1 BBB images booted the stock bone
    kernel, which cannot run the PRU, so every PRU-driven cape stayed dark.
    """
    bbb_kernels(fppinit)
    r, out = step(fppinit, 144)
    assert r.returncode == 0, out[-3000:]
    assert uenv(fppinit) == "uname_r=7.1.6-fpp16\ncmdline=coherent_pool=1M quiet\n", \
        f"{uenv(fppinit)}\n{out[-3000:]}"
    assert media_settings(fppinit).get("rebootFlag") == "1", fppinit.media_file("settings")
    assert not [c for c in fppinit.calls() if c.startswith(("reboot", "shutdown"))], fppinit.calls()

    fppinit.write("settings", "")
    r, out = step(fppinit, 144)
    assert r.returncode == 0 and "nothing to do" in out, out[-3000:]
    assert "rebootFlag" not in media_settings(fppinit)

    boot_write(fppinit, "uEnv.txt", "uname_r=6.18.52-bone54\n")
    fppinit.root_file("/etc/fpp/platform", "BeagleBone 64\n")
    r, out = step(fppinit, 144)
    assert r.returncode == 0, out[-3000:]
    assert uenv(fppinit) == "uname_r=6.18.52-bone54\n", "a BeagleBone 64 was repointed"


# dpkg-query: the stock kernel packages for a pattern query, and nothing
# installed by an exact name once apt-get (a stub) has "purged" them.
DPKG_QUERY = """#!/bin/sh
case "$*" in
    *'*'*) printf 'ii  bbb.io-kernel-6.18-bone\\nii  linux-image-6.18.52-bone54\\n'
           printf 'ii  linux-image-7.1.6-fpp16\\nrc  linux-image-6.12.1-bone9\\n' ;;
esac
exit 0
"""

PIN = "/etc/apt/preferences.d/fpp-kernel-pin"


def test_upgrade_150_keeps_the_stock_kernel_off_a_bbb(fppinit):
    """Upgrade 150, on a BBB booting an FPP kernel, pins the stock bone
    kernels out of apt, purges the installed ones and their metapackage --
    never the kernel it boots -- with what dpkg left of them, and leaves
    uEnv.txt booting the same kernel; with the pin in place and no stock
    kernel left, it changes nothing.

    Regression: 900bdc0e8. 144 left the stock kernel and its metapackage
    installed, so the next apt upgrade pulled a newer one whose postinst
    pointed uEnv.txt back at it.
    """
    bbb_kernels(fppinit, booted="7.1.6-fpp16")
    fppinit.root_file("/usr/bin/dpkg-query", DPKG_QUERY)
    r, out = step(fppinit, 150)
    assert r.returncode == 0, out[-3000:]
    pin = fppinit.written(PIN)
    assert pin and "Pin-Priority: -1" in pin and "linux-image-*-bone*" in pin, f"{pin}\n{out[-3000:]}"
    removes = [c for c in fppinit.calls() if c.startswith("apt-get") and " remove " in c]
    assert len(removes) == 1, f"{fppinit.calls()}\n{out[-3000:]}"
    pkgs = set(removes[0].split())
    assert {"bbb.io-kernel-6.18-bone", "linux-image-6.18.52-bone54"} <= pkgs, removes
    assert "linux-image-7.1.6-fpp16" not in pkgs, f"the booted kernel was purged: {removes}"
    assert "linux-image-6.12.1-bone9" not in pkgs, f"a package already removed was purged: {removes}"
    assert not upper_isdir(fppinit, "/usr/lib/modules/6.18.52-bone54"), "the stock kernel's modules were left"
    assert not os.path.exists(os.path.join(fppinit.boot, "dtbs", "6.18.52-bone54")), "its DTBs were left"
    assert os.path.isdir(os.path.join(fppinit.boot, "dtbs", "7.1.6-fpp16"))
    assert uenv(fppinit).startswith("uname_r=7.1.6-fpp16\n"), uenv(fppinit)

    fppinit.root_file(PIN, pin)
    fppinit.root_file("/usr/bin/dpkg-query", "#!/bin/sh\nexit 0\n")
    r, out = step(fppinit, 150)
    assert r.returncode == 0 and "already in place" in out, out[-3000:]
    assert not [c for c in fppinit.calls() if c.startswith("apt-get")], fppinit.calls()


# --- 131: the stock 16K-page Pi 5 kernel ------------------------------------

PI_PIN = "/etc/apt/preferences.d/fpp-no-2712-kernel"


def test_upgrade_131_takes_a_stock_2712_kernel_off_an_fpp_pi(fppinit):
    """Upgrade 131, on a Pi whose FPP image has no stock 2712 module tree
    and a kernel_2712.img on the boot partition beside kernel8.img: pins
    linux-image-*-rpi-2712 out of apt, sets KERNEL=none for raspi-firmware,
    removes kernel_2712.img (keeping kernel8.img) and flags a reboot, the
    running kernel having no modules. A Pi with a stock 2712 module tree --
    Raspberry Pi OS with FPP installed on top -- is left as it is.

    Regression: 62affa110. Nothing kept apt from installing a newer stock
    2712 kernel, and a Pi 5 boots kernel_2712.img in preference to
    kernel8.img: the box came up on a 16K-page kernel with no modules at
    all (no ipv6 for apache, a 90 s zram timeout at boot)."""
    fppinit.root_file("/etc/fpp/platform", "Raspberry Pi\n")
    boot_write(fppinit, "kernel8.img", "fpp kernel")
    boot_write(fppinit, "kernel_2712.img", "stock 16K kernel")
    r, out = step(fppinit, 131)
    assert r.returncode == 0, out[-3000:]
    pin = fppinit.written(PI_PIN)
    assert pin and "Pin-Priority: -1" in pin and "linux-image-*-rpi-2712" in pin, f"{pin}\n{out[-3000:]}"
    assert "KERNEL=none" in (fppinit.written("/etc/default/raspi-firmware") or ""), out[-3000:]
    assert not os.path.exists(os.path.join(fppinit.boot, "kernel_2712.img")), out[-3000:]
    assert os.path.exists(os.path.join(fppinit.boot, "kernel8.img"))
    assert media_settings(fppinit).get("rebootFlag") == "1", f"{media_settings(fppinit)}\n{out[-3000:]}"


def test_upgrade_131_leaves_a_pi_with_stock_2712_modules_alone(fppinit):
    """Upgrade 131 on a Pi that has a stock 2712 module tree (Raspberry Pi
    OS, FPP installed on top, its own kernel legitimately): no pin, no
    raspi-firmware change, and kernel_2712.img stays.

    Regression: 62affa110 (the gate of its upgrade step)."""
    fppinit.root_file("/etc/fpp/platform", "Raspberry Pi\n")
    fppinit.root_file("/lib/modules/6.12.47+rpt-rpi-2712/modules.dep", "")
    boot_write(fppinit, "kernel8.img", "fpp kernel")
    boot_write(fppinit, "kernel_2712.img", "stock 16K kernel")
    r, out = step(fppinit, 131)
    assert r.returncode == 0, out[-3000:]
    assert "manages its own kernel" in out, out[-3000:]
    assert not fppinit.written(PI_PIN), out[-3000:]
    assert os.path.exists(os.path.join(fppinit.boot, "kernel_2712.img")), out[-3000:]


# --- 145 and 149: Pi overlays that leave the pins free ----------------------

# Stands in for dtc where the system has none (images built before it was
# added): writes a stand-in .dtbo where -o says. With the real one the
# overlay sources themselves are compiled.
DTC = """#!/bin/sh
while [ $# -gt 0 ]; do
    if [ "$1" = -o ]; then printf 'dtbo' > "$2"; shift; fi
    shift
done
exit 0
"""

REAL_DTC = bool(shutil.which("dtc"))


def pi_boot(sb, config):
    sb.root_file("/etc/fpp/platform", "Raspberry Pi\n")
    if not REAL_DTC:
        sb.root_file("/usr/bin/dtc", DTC)
    boot_write(sb, "config.txt", config)
    boot_mkdir(sb, "overlays")


def assert_overlay(sb, name):
    with open(os.path.join(sb.boot, "overlays", name), "rb") as f:
        data = f.read()
    assert data, f"{name} is empty"
    if REAL_DTC:
        assert data[:4] == b"\xd0\x0d\xfe\xed", f"{name} is not a device tree blob"


def test_upgrade_145_moves_uart0_to_the_overlay_that_leaves_gpio14_free(fppinit):
    """Upgrade 145 installs fpp-uart0-nopins.dtbo and replaces a
    line-anchored dtparam=uart0=on with it (indented and commented copies
    stay as they are), flagging a reboot; if the overlay doesn't compile,
    config.txt is left as it was and the step fails.

    Regression: e0e2287f5. dtparam=uart0=on on a Pi 5 claimed GPIO14 and
    GPIO15 for the UART, so neither could be used as a GPIO. (Where the
    system has no dtc, a stand-in: the overlay source is then not
    compiled.)
    """
    config = "[pi5]\ndtparam=uart0=on\n  dtparam=uart0=on\n#dtparam=uart0=on\n[all]\n"
    pi_boot(fppinit, config)
    r, out = step(fppinit, 145)
    assert r.returncode == 0, out[-3000:]
    assert fppinit.boot_file("config.txt") == \
        "[pi5]\ndtoverlay=fpp-uart0-nopins\n  dtparam=uart0=on\n#dtparam=uart0=on\n[all]\n", out[-3000:]
    assert_overlay(fppinit, "fpp-uart0-nopins.dtbo")
    assert media_settings(fppinit).get("rebootFlag") == "1"

    pi_boot(fppinit, config)
    os.remove(os.path.join(fppinit.boot, "overlays", "fpp-uart0-nopins.dtbo"))
    fppinit.root_file("/usr/bin/dtc", "#!/bin/sh\nexit 1\n")
    r, out = step(fppinit, 145)
    assert r.returncode != 0, out[-3000:]
    assert fppinit.boot_file("config.txt") == config


def test_upgrade_149_adds_the_spi1_overlay_after_spi0(fppinit):
    """Upgrade 149 installs fpp-spi1-nopins.dtbo and adds its dtoverlay
    line right after dtoverlay=spi0-0cs, flagging a reboot; run again, or
    on a config.txt that already mentions it (even commented out), it adds
    nothing.

    Regression: b12b7c6f3. Pis updated in place never got the overlay that
    gives SPI1 without claiming GPIO19-21, which new images carry. (Where
    the system has no dtc, a stand-in.)
    """
    pi_boot(fppinit, "[all]\ndtoverlay=spi0-0cs\ndtparam=audio=on\n")
    r, out = step(fppinit, 149)
    assert r.returncode == 0, out[-3000:]
    after = fppinit.boot_file("config.txt")
    assert after == "[all]\ndtoverlay=spi0-0cs\ndtoverlay=fpp-spi1-nopins\ndtparam=audio=on\n", \
        f"{after}\n{out[-3000:]}"
    assert_overlay(fppinit, "fpp-spi1-nopins.dtbo")
    assert media_settings(fppinit).get("rebootFlag") == "1"

    r, out = step(fppinit, 149)
    assert r.returncode == 0 and fppinit.boot_file("config.txt") == after, out[-3000:]

    pi_boot(fppinit, "[all]\n#dtoverlay=fpp-spi1-nopins\n")
    r, out = step(fppinit, 149)
    assert r.returncode == 0 and fppinit.boot_file("config.txt") == "[all]\n#dtoverlay=fpp-spi1-nopins\n", out


# --- 147: a stale mp3gain ---------------------------------------------------

BROKEN_MP3GAIN = """#!/bin/sh
echo "mp3gain: symbol lookup error: mp3gain: undefined symbol: mpg123_decode_frame" >&2
exit 127
"""


def test_upgrade_147_reinstalls_a_broken_mp3gain(fppinit):
    """Upgrade 147 reinstalls mp3gain when the binary dies in the loader
    against the new libmpg123 (a stale file an OS upgrade left), and leaves
    a working one alone.

    Regression: 9d63c8b2d. Boxes upgraded from FPP 8/9 kept the old binary,
    and every normalization failed with "undefined symbol".
    """
    fppinit.root_file("/usr/bin/mp3gain", BROKEN_MP3GAIN)
    r, out = step(fppinit, 147)
    assert r.returncode == 0, out[-3000:]
    assert "apt-get install --reinstall -y mp3gain" in fppinit.calls(), f"{fppinit.calls()}\n{out[-3000:]}"

    fppinit.root_file("/usr/bin/mp3gain", "#!/bin/sh\necho 'mp3gain version 1.6.2'\n")
    r, out = step(fppinit, 147)
    assert r.returncode == 0 and "works" in out, out[-3000:]
    assert not [c for c in fppinit.calls() if c.startswith("apt-get")], fppinit.calls()


# --- 148: exim's daemon ----------------------------------------------------

def test_upgrade_148_replaces_the_exim_daemon_with_a_retry_timer(fppinit):
    """Upgrade 148 installs fpp-exim-queue.timer and its service, enables
    the timer and disables the exim daemon; with no exim installed it does
    nothing.

    Regression: 544c7372a. The daemon regenerated a self-signed RSA
    certificate about every 90 minutes, seconds of CPU on a single-core
    board, for a listener nothing used.
    """
    fppinit.root_file("/etc/fpp/container", None)  # 148 skips in a container
    fppinit.root_file("/usr/sbin/exim4", "#!/bin/sh\nexit 0\n")
    r, out = step(fppinit, 148)
    assert r.returncode == 0, out[-3000:]
    for unit in ("fpp-exim-queue.service", "fpp-exim-queue.timer"):
        with open(os.path.join(fppinit.tree, "etc", "systemd", unit)) as f:
            assert fppinit.written(f"{UNITS}/{unit}") == f.read(), f"{unit} not installed:\n{out[-3000:]}"
    calls = fppinit.calls()
    assert "systemctl enable --now fpp-exim-queue.timer" in calls, calls
    assert "systemctl disable --now exim4.service" in calls, calls
    assert calls.index("systemctl enable --now fpp-exim-queue.timer") < \
        calls.index("systemctl disable --now exim4.service"), "the daemon went before its replacement"

    fppinit.root_file("/usr/sbin/exim4", None)
    r, out = step(fppinit, 148)
    assert r.returncode == 0, out[-3000:]
    assert not [c for c in fppinit.calls() if "exim" in c], fppinit.calls()


def test_upgrade_113_gives_networkd_dispatcher_back_to_root(fppinit):
    """Upgrade 113 makes a non-root-owned /etc/networkd-dispatcher tree
    root:root again, and on a second run finds it so and changes nothing.

    Regression: 31dd89043. upgrade/80 and 90 copied the hooks with cp -af,
    which kept /opt/fpp's owner; networkd-dispatcher then refused to run
    them ("invalid permissions"), which broke the time-sync hook."""
    fppinit.root_file("/etc/networkd-dispatcher/routable.d/ntpd", "#!/bin/sh\n")
    fppinit.write("settings", "")
    r = fppinit._run(["sh", "-c", "chown -R 1001:1001 /etc/networkd-dispatcher && "
                                  "/opt/fpp/upgrade/113/upgrade.sh; echo \"exited $?\"; "
                                  "find /etc/networkd-dispatcher ! -uid 0 -o ! -gid 0; "
                                  "echo second; /opt/fpp/upgrade/113/upgrade.sh; echo \"exited $?\""],
                     timeout=120, media_home=True)
    out = r.stdout + r.stderr
    first, second = out.split("second", 1)
    assert "exited 0" in first, out[-3000:]
    assert "/etc/networkd-dispatcher" not in first.split("exited 0", 1)[1], \
        f"still not root-owned after upgrade 113:\n{out[-3000:]}"
    assert "already root-owned" in second and "exited 0" in second, out[-3000:]


def no_profile(sb):
    """The fpp user's home as the sandbox has it, without the dotfiles
    upgrade 114 restores."""
    for f in (".profile", ".bash_logout"):
        sb.root_file(f"/home/fpp/{f}", None)


def test_upgrade_114_restores_a_missing_profile_and_asks_for_a_reboot(fppinit):
    """Upgrade 114 puts back a missing ~/.profile from /etc/skel, owned by
    fpp, so login shells source ~/.bashrc (and the kiosk's startx runs),
    and sets the reboot flag for it.

    Regressions: 0e154d606 (with no ~/.profile, login shells never read
    ~/.bashrc and Kiosk mode never started on trixie) and bc6245d44 (the
    fix needed a reboot to take effect and nothing asked for one)."""
    if not os.path.exists("/etc/skel/.profile"):
        pytest.skip("no /etc/skel/.profile here")
    fpp = fpp_user(fppinit)
    no_profile(fppinit)
    r, out = step(fppinit, 114)
    profile = fppinit.written("/home/fpp/.profile")
    assert profile is not None, f"~/.profile was not restored:\n{out[-3000:]}"
    with open("/etc/skel/.profile") as f:
        assert profile == f.read()
    uid = os.stat(os.path.join(fppinit.upper, "home/fpp/.profile")).st_uid
    assert uid == fpp, f"~/.profile is owned by uid {uid}"
    assert media_settings(fppinit).get("rebootFlag") == "1", f"no reboot asked for:\n{out[-3000:]}"


def test_upgrade_114_leaves_a_present_profile_alone(fppinit):
    """With ~/.profile there, upgrade 114 changes nothing and asks for no
    reboot (the control for the test above)."""
    no_profile(fppinit)
    fppinit.root_file("/home/fpp/.profile", "# the user's own\n")
    r, out = step(fppinit, 114)
    assert fppinit.written("/home/fpp/.profile") == "# the user's own\n", out[-3000:]
    assert media_settings(fppinit).get("rebootFlag") != "1", out[-3000:]


def test_upgrade_120_reloads_apache_rather_than_restarting_it(fppinit):
    """Upgrade 120 recopies the Apache site for the /fppdws WebSocket and
    reloads Apache gracefully: it runs inside a request Apache is serving
    (the browser's upgrade window), which a restart would cut off.

    Regression: 50e074f93. It restarted Apache, which dropped the streaming
    upgrade request and left the upgrade page hanging."""
    fppinit.service("apache2", active=True)
    fppinit.root_file("/etc/apache2/sites-enabled/.fpp-test", "")
    r, out = step(fppinit, 120)
    calls = [c for c in fppinit.calls() if "apache" in c]
    assert not [c for c in calls if "restart" in c], f"Apache was restarted: {calls}"
    assert [c for c in calls if "reload apache2" in c or "graceful" in c], f"Apache was not reloaded: {calls}"


def test_upgrade_104_recopies_the_apache_site_and_reloads(fppinit):
    """Upgrade 104 replaces a stale Apache site with the tree's
    etc/apache2.site (its proxy rewrite rules in the order the 3D
    visualizer needs) and reloads Apache.

    Added in c95fda85c: an existing box kept its old site file, whose rule
    order broke the 3D visualizer's proxied requests."""
    fppinit.service("apache2", active=True)
    fppinit.root_file("/etc/apache2/sites-enabled/000-default.conf", "# a stale site\n")
    r = fppinit._run(["sh", "-c", "/opt/fpp/upgrade/104/upgrade.sh; "
                                  "cmp /opt/fpp/etc/apache2.site /etc/apache2/sites-enabled/000-default.conf "
                                  "&& echo site-current"], timeout=120, media_home=True)
    out = r.stdout + r.stderr
    assert "site-current" in out, f"the Apache site is not the tree's:\n{out[-3000:]}"
    calls = [c for c in fppinit.calls() if "apache" in c]
    assert [c for c in calls if "reload apache2" in c], f"Apache was not reloaded: {calls}"


def test_upgrade_108_renames_audio_backend_to_media_backend(fppinit):
    """Upgrade 108 renames the AudioBackend setting to MediaBackend,
    keeping its value, which fppd and the UI now read.

    Added in 5ca5270f4: without it a box set to PipeWire would read no
    MediaBackend after the update and fall back to the default backend."""
    fppinit.write("settings", 'AudioBackend = "pipewire"\nVolume = "70"\n')
    r, out = step(fppinit, 108)
    s = media_settings(fppinit)
    assert s.get("MediaBackend") == "pipewire", f"{s}\n{out[-3000:]}"
    assert "AudioBackend" not in s, s
    assert s.get("Volume") == "70", s


@pytest.mark.parametrize("backend", [None, "alsa"])
def test_upgrade_109_moves_alsa_media_to_simple_pipewire(fppinit, backend):
    """Upgrade 109 moves a box on the ALSA media backend (set, or unset as
    old boxes are) to Simple PipeWire, drops the ALSA-only ForceHDMI and
    EnableBBBHDMI settings and asks for a reboot; one already on PipeWire
    is left alone.

    Added in 05fa13c01."""
    settings = 'ForceHDMI = "1"\nEnableBBBHDMI = "1"\nForceHDMIResolution = "1920x1080"\n'
    if backend:
        settings += f'MediaBackend = "{backend}"\n'
    fppinit.write("settings", settings)
    r, out = step(fppinit, 109)
    s = media_settings(fppinit)
    assert s.get("MediaBackend") == "pipewire-simple", f"{s}\n{out[-3000:]}"
    assert "ForceHDMI" not in s and "EnableBBBHDMI" not in s, s
    assert s.get("ForceHDMIResolution") == "1920x1080", s
    assert s.get("rebootFlag") == "1", s

    fppinit.write("settings", 'MediaBackend = "pipewire"\n')
    step(fppinit, 109)
    assert media_settings(fppinit) == {"MediaBackend": "pipewire"}, media_settings(fppinit)


@pytest.mark.parametrize("model", ["Raspberry Pi Zero 2 W Rev 1.0", "Raspberry Pi 4 Model B Rev 1.5"])
def test_upgrade_111_fixes_hdmi_audio_on_a_pi_zero_2(fppinit, model):
    """On a Pi Zero 2 W, upgrade 111 adds dtparam=audio=off (and the HDMI
    hotplug and drive lines) to config.txt's [pi02] section and takes the
    snd_bcm2835 parameters out of cmdline.txt, asking for a reboot; another
    Pi model is left alone.

    Added in f593f00a8: existing Zero 2 W installs kept a config that gave
    them no HDMI sound."""
    if not os.path.exists("/sys/firmware/devicetree/base/model"):
        pytest.skip("no device tree here to stand a Pi Zero 2 W's model in")
    config = "[all]\ndtoverlay=vc4-kms-v3d\n[pi02]\nhdmi_drive=2\n"
    cmdline = "console=tty1 root=/dev/mmcblk0p2 snd_bcm2835.enable_headphones=1 snd_bcm2835.enable_hdmi=0 rootwait\n"
    pi_boot(fppinit, config)
    boot_write(fppinit, "cmdline.txt", cmdline)
    fppinit.fake_path("/sys/firmware/devicetree/base/model", model + "\0")
    fppinit.write("settings", "")
    r, out = step(fppinit, 111)
    with open(os.path.join(fppinit.boot, "config.txt")) as f:
        got_config = f.read()
    with open(os.path.join(fppinit.boot, "cmdline.txt")) as f:
        got_cmdline = f.read()
    if "Zero 2" not in model:
        assert (got_config, got_cmdline) == (config, cmdline), out[-3000:]
        assert media_settings(fppinit).get("rebootFlag") != "1"
        return
    pi02 = got_config.split("[pi02]", 1)[1].split("[", 1)[0].split()
    for line in ("dtparam=audio=off", "hdmi_force_hotplug=1", "hdmi_drive=2"):
        assert pi02.count(line) == 1, f"[pi02] has {pi02}:\n{out[-3000:]}"
    assert got_cmdline == "console=tty1 root=/dev/mmcblk0p2 rootwait\n", got_cmdline
    assert media_settings(fppinit).get("rebootFlag") == "1", out[-3000:]


def test_upgrade_115_clears_stale_xauth_locks_and_fixes_home_ownership(fppinit):
    """Upgrade 115 removes the stale ~/.Xauthority-c and -l locks that kept
    the kiosk's X from starting and gives files in fpp's home that another
    user owns back to fpp; a second run finds nothing to do.

    Added in 853cbb79d (kiosk fixes)."""
    fpp = fpp_user(fppinit)
    for f in (".Xauthority-c", ".Xauthority-l", ".fpp-test-root-owned"):
        fppinit.root_file(f"/home/fpp/{f}", "")
    fppinit.write("settings", "")
    r = fppinit._run(["sh", "-c", "/opt/fpp/upgrade/115/upgrade.sh; ls -a /home/fpp"], timeout=120,
                     media_home=True)
    out = r.stdout + r.stderr
    left = [f for f in (".Xauthority-c", ".Xauthority-l") if f in out.split()]
    assert not left, f"{left} still there:\n{out[-3000:]}"
    owned = os.stat(os.path.join(fppinit.upper, "home/fpp/.fpp-test-root-owned")).st_uid
    assert owned == fpp, f"a root-owned file in fpp's home is still uid {owned}:\n{out[-3000:]}"


def test_upgrade_98_moves_the_ui_password_out_of_htaccess(fppinit):
    """Upgrade 98 recopies the Apache site (which includes the separate
    ui-password-config.conf), removes the media directory's .htaccess, and
    writes an open password config for the new file, owned by fpp, then
    reloads Apache.

    Added in d8cb94998: the UI password moved from config/.htaccess to an
    Apache config file; a box still on the old layout lost its (open) access
    rules."""
    fpp_user(fppinit)
    fppinit.service("apache2", active=True)
    fppinit.root_file("/etc/apache2/sites-enabled/000-default.conf", "# a stale site\n")
    fppinit.write("config/.htaccess", "Require valid-user\n")
    r = fppinit._run(["sh", "-c", "/opt/fpp/upgrade/98/upgrade.sh; "
                                  "cmp /opt/fpp/etc/apache2.site /etc/apache2/sites-enabled/000-default.conf "
                                  "&& echo site-current; "
                                  "stat -c %U /home/fpp/media/config/ui-password-config.conf"],
                     timeout=120, media_home=True)
    out = r.stdout + r.stderr
    assert "site-current" in out and out.strip().endswith("fpp"), out[-3000:]
    assert not fppinit.media_exists("config/.htaccess")
    assert "LOCAL_PROTECT=0" in fppinit.media_file("config/ui-password-config.conf")
    assert [c for c in fppinit.calls() if "reload apache2" in c], fppinit.calls()


def test_upgrade_99_recopies_the_apache_site_with_the_proxy_rules_first(fppinit):
    """Upgrade 99 replaces a stale Apache site with the tree's, whose
    proxy-config.conf include comes before the generic /api rules, and
    reloads Apache.

    Added in 451411658: the proxy rewrite rules sat after the generic rules
    and a Falcon v5 controller's proxied pages were answered by the wrong
    rule."""
    fppinit.service("apache2", active=True)
    fppinit.root_file("/etc/apache2/sites-enabled/000-default.conf", "# a stale site\n")
    r = fppinit._run(["sh", "-c", "/opt/fpp/upgrade/99/upgrade.sh; "
                                  "cmp /opt/fpp/etc/apache2.site /etc/apache2/sites-enabled/000-default.conf "
                                  "&& echo site-current"], timeout=120, media_home=True)
    assert "site-current" in r.stdout + r.stderr, r.stdout + r.stderr
    assert [c for c in fppinit.calls() if "reload apache2" in c], fppinit.calls()
    with open(os.path.join(fppinit.tree, "etc/apache2.site")) as f:
        site = f.read()
    assert site.index("config/proxy-config.conf") < site.index("RewriteRule ^(192"), "the proxy rules come after the generic api rules"
