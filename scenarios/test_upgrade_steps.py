"""Config upgrade steps (upgrade/<n>/upgrade.sh) and the upgrade_config
loop that runs them, in the fppinit sandbox (fppinit.py): what each step
changes in /etc, the boot directory and the settings, and which commands
it would run.

A step is run directly, as upgrade_config runs it. The media directory is
also mounted at /home/fpp/media, where scripts/common finds it from an
upgrade step's own path.
"""

import os
import shutil
import stat

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture

TREE = os.environ.get("FPP_TREE", "")


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
