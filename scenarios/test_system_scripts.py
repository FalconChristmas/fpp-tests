"""FPP's system scripts (config upgrades, storage formatting), run as root
in the fppinit sandbox (fppinit.py): their writes outside the media
directory land in a throwaway overlay, and systemctl, sfdisk and the like
are stubs that record their calls.
"""

import os
import re
import signal
import subprocess
import time

from fppinit import MEDIA, _stub, fppinit  # noqa: F401 -- the fixture

CALLS = "/fppinit-calls.log"
TREE = os.environ.get("FPP_TREE", "")


def fppdir_view(sb):
    """FPPDIR as the sandbox sees it, but with a www/media_root.txt naming
    the sandbox's media directory. The tree's own copy names whatever fppd
    last started from it, other runs' included. Returns its path inside
    the sandbox."""
    view = os.path.join(sb.media, "tmp", "fppdir")
    os.makedirs(os.path.join(view, "www"))
    for entry in os.listdir(sb.tree):
        if entry != "www":
            os.symlink(f"/opt/fpp/{entry}", os.path.join(view, entry))
    for entry in os.listdir(os.path.join(sb.tree, "www")):
        if entry != "media_root.txt":
            os.symlink(f"/opt/fpp/www/{entry}", os.path.join(view, "www", entry))
    with open(os.path.join(view, "www", "media_root.txt"), "w") as f:
        f.write(MEDIA)
    return f"{MEDIA}/tmp/fppdir"


def test_upgrade_config_fails_when_a_migration_fails(fppinit):
    """A config upgrade script that fails stops upgrade_config with a
    non-zero exit, and the config version stays where it was so the next
    run retries it.

    Regression: 29667d383. upgrade_config exited 0 after a failed
    migration, so its callers (and the op log) reported a clean upgrade.
    """
    fake = os.path.join(fppinit.media, "tmp", "fakefpp")
    fppinit.write("tmp/fakefpp/upgrade/1/upgrade.sh", "#!/bin/sh\necho migration-1-ran\nexit 3\n")
    os.chmod(os.path.join(fake, "upgrade", "1", "upgrade.sh"), 0o755)
    fppinit.write("tmp/cv", "0\n")
    r = fppinit._run(["env", f"FPPDIR={MEDIA}/tmp/fakefpp", f"CFGVERSIONFILE={MEDIA}/tmp/cv",
                      "/opt/fpp/scripts/upgrade_config", "-notee"])
    out = r.stdout + r.stderr
    assert "migration-1-ran" in out, f"the failing migration never ran:\n{out[-3000:]}"
    assert fppinit.media_file("tmp/cv").strip() == "0", "the version moved past a failed migration"
    assert r.returncode == 1, f"upgrade_config exited {r.returncode} after a failed migration:\n{out[-3000:]}"


def test_config_upgrades_finish_without_a_running_apache(fppinit):
    """From config version 154, upgrade_config reaches the newest version
    on a system whose Apache is not a running systemd unit (a container,
    an image build): there is nothing to reload, which is not a failure.

    Regression: 590a7a522. gracefullyReloadApacheConf returned 1 when apache2
    wasn't active, and upgrade 155 (like 94-143's Apache ones) ends with it,
    so upgrade_config stopped at 154 and 156 and every later migration
    never ran.
    """
    latest = max(int(d) for d in os.listdir(os.path.join(fppinit.tree, "upgrade")) if d.isdigit())
    view = fppdir_view(fppinit)
    fppinit.write("tmp/cv", "154\n")
    fppinit.service("apache2", active=False)
    r = fppinit._run(["env", f"FPPDIR={view}", f"CFGVERSIONFILE={view}/../cv",
                      f"{view}/scripts/upgrade_config", "-notee"])
    out = r.stdout + r.stderr
    assert "Upgrading config to version 155" in out, out[-3000:]
    assert fppinit.media_file("tmp/cv").strip() == str(latest), \
        f"stopped at config version {fppinit.media_file('tmp/cv').strip()}, not {latest}:\n{out[-3000:]}"
    assert r.returncode == 0, out[-3000:]


def test_upgrade_151_masks_the_user_pipewire_units(fppinit):
    """Upgrade 151 masks every per-user PipeWire unit system-wide
    (systemctl --global mask), filter-chain included.

    Regression: 0efdfecae. Before it the units were masked only in
    ~fpp/.config/systemd/user, which an fppos upgrade never carries over.
    (Weak: red on the parent only because the script isn't there; it guards
    the unit list.)
    """
    fppinit.root_file("/etc/fpp/container", None)  # 151 skips in a container
    r = fppinit._run(["/opt/fpp/upgrade/151/upgrade.sh"])
    out = r.stdout + r.stderr
    assert r.returncode == 0, f"151 exited {r.returncode}:\n{out[-3000:]}"
    masks = [c for c in fppinit.calls() if c.startswith("systemctl") and " mask " in c and "--global" in c]
    assert masks, f"no systemctl --global mask: {fppinit.calls()}\n{out[-2000:]}"
    units = set(masks[0].split())
    for unit in ("pipewire.socket", "pipewire.service", "pipewire-pulse.socket",
                 "pipewire-pulse.service", "wireplumber.service", "filter-chain.service"):
        assert unit in units, f"{unit} is not masked: {masks}"


CHRONY_HOOK = "/etc/networkd-dispatcher/routable.d/chrony"


def test_upgrade_159_installs_the_current_chrony_hook(fppinit):
    """Upgrade 159 replaces an old chrony reconnect hook with the tree's,
    root-owned and executable as networkd-dispatcher requires, and leaves
    a player without chrony alone.

    Regression: 38efe6f55. cfa731d71 fixed the hook in the tree, but only an
    install and upgrade 116 copy it into /etc, so a git-updated player kept
    the one that left the clock flagged unsynchronized after a reconnect.
    """
    with open(os.path.join(fppinit.tree, CHRONY_HOOK.replace("/etc/", "etc/", 1))) as f:
        current = f.read()
    fppinit.root_file("/etc/fpp/container", None)  # 159 skips in a container
    # No "#!", so root_file() leaves it 644: the upgrade must make it executable.
    fppinit.root_file(CHRONY_HOOK, "/usr/bin/chronyc makestep\n")
    fppinit.root_file("/usr/bin/chronyc", "#!/bin/sh\nexit 0\n")
    r = fppinit._run(["/opt/fpp/upgrade/159/upgrade.sh"])
    out = r.stdout + r.stderr
    assert r.returncode == 0, f"159 exited {r.returncode}:\n{out[-3000:]}"
    assert fppinit.written(CHRONY_HOOK) == current, f"the old hook is still in place:\n{out[-3000:]}"
    st = os.stat(os.path.join(fppinit.upper, CHRONY_HOOK.lstrip("/")))
    assert st.st_uid == 0 and st.st_mode & 0o777 == 0o755, f"uid {st.st_uid}, mode {oct(st.st_mode)}"

    # Again: already current, nothing to do, still a success.
    fppinit.root_file(CHRONY_HOOK, current)
    r = fppinit._run(["/opt/fpp/upgrade/159/upgrade.sh"])
    assert r.returncode == 0 and "already current" in r.stdout, r.stdout + r.stderr

    # No chrony: no hook installed, and not a failure that would hold back
    # every later upgrade.
    fppinit.root_file(CHRONY_HOOK, None)
    fppinit.root_file("/usr/bin/chronyc", None)
    r = fppinit._run(["/opt/fpp/upgrade/159/upgrade.sh"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert fppinit.written(CHRONY_HOOK) is None, r.stdout


def storage_stubs(sb):
    # Neither is in the test image, and on a device mkfs must not run.
    for tool in ("/usr/sbin/sfdisk", "/usr/sbin/mkfs.ext4", "/sbin/mkfs.ext4"):
        sb.root_file(tool, _stub(CALLS))


def test_format_storage_splits_a_two_digit_partition(fppinit):
    """format_storage.sh splits sda10 into disk sda, partition 10, and so
    sets the type of the partition it then formats.

    Regression: 77a2245fb. It cut one character off the end, so sda10 was
    disk sda1, partition 0: sfdisk was pointed at the wrong device.
    """
    storage_stubs(fppinit)
    r = fppinit._run(["/opt/fpp/scripts/format_storage.sh", "ext4", "sda10"])
    calls = fppinit.calls()
    sfdisk = [c for c in calls if c.startswith("sfdisk")]
    assert sfdisk, f"sfdisk never ran: {calls}\n{(r.stdout + r.stderr)[-2000:]}"
    assert sfdisk[0] == "sfdisk --part-type /dev/sda 10 83", sfdisk
    assert any(c.startswith("mkfs.ext4") and c.endswith("/dev/sda10") for c in calls), calls


def test_format_storage_refuses_an_unknown_filesystem(fppinit):
    """An unknown filesystem type is an error, not a silent success.

    Regression: 77a2245fb. An unknown type formatted nothing and exited 0.
    """
    storage_stubs(fppinit)
    r = fppinit._run(["/opt/fpp/scripts/format_storage.sh", "bogus", "sda1"])
    assert r.returncode != 0, f"exited 0 for an unknown filesystem:\n{(r.stdout + r.stderr)[-2000:]}"
    assert not [c for c in fppinit.calls() if c.startswith(("sfdisk", "mkfs"))], fppinit.calls()


def test_fppos_for_another_architecture_is_refused_before_any_change(fppinit):
    """An OS image whose shell is built for another CPU (a Pi64 .fppos on
    a 32-bit Pi, say) is refused by upgradeOS-part1.sh before it changes
    anything, and the script exits non-zero so the page reports it rather
    than rebooting.

    Regression: a21091157. Images from before FPP 10 have no arch marker to
    compare, so part1 went on: it queued the post-upgrade settings pass,
    ignored chroot's failure to run the image's part2, and exited 0, and the
    box rebooted into the unchanged OS.
    """
    # e_machine 8 (MIPS): neither side of any FPP platform.
    fppinit.root_file("/mnt/bin/bash", "\x7fELF\x01\x01\x01" + "\x00" * 11 + "\x08\x00" + "\x00" * 44)
    fppinit.root_file("/etc/fpp/platform", "Raspberry Pi\n")
    fppinit.root_file("/mnt/etc/fpp/platform", "Raspberry Pi\n")
    fppinit.root_file("/etc/fpp/arch", None)
    fppinit.write("upload/fpp-tests.fppos", "not really an image\n")
    fppinit.write("settings", "")
    r = fppinit._run(["/opt/fpp/SD/upgradeOS-part1.sh", "/home/fpp/media/upload/fpp-tests.fppos"],
                     media_home=True)
    out = r.stdout + r.stderr
    assert "Verifying image" in out, f"part1 stopped before its checks:\n{out[-3000:]}"
    assert "BootActions" not in fppinit.media_file("settings"), \
        f"part1 went on to change the system:\n{out[-3000:]}"
    assert "New image is for" in out, f"no word of the architecture mismatch:\n{out[-3000:]}"
    assert r.returncode != 0, f"part1 exited 0:\n{out[-3000:]}"


def test_avahi_hostname_hook_takes_back_a_renamed_mdns_name(tmp_path):
    """The routable networkd-dispatcher hook sets avahi's mDNS host name
    back to the system host name when avahi has renamed itself to
    "<hostname>-N", a few seconds after the interface comes up.

    Regression: bb7b9a08c. Nothing undid avahi's rename, which it makes on
    most boots by hearing its own announcement, so <hostname>.local stopped
    resolving until avahi restarted. (Red on the parent only because the
    hook isn't there.)
    """
    tree = os.environ["FPP_TREE"]
    log = tmp_path / "busctl.log"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "hostname").write_text("#!/bin/sh\necho fpp-tests\n")
    (bin_dir / "busctl").write_text(
        f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> {log}\n"
        'case "$*" in *GetHostName*) echo \'s "fpp-tests-2"\' ;; esac\n')
    for f in bin_dir.iterdir():
        f.chmod(0o755)
    hook = os.path.join(tree, "etc", "networkd-dispatcher", "routable.d", "avahi_hostname")
    assert os.path.exists(hook), "no avahi_hostname hook in the tree"
    p = subprocess.Popen(["sh", hook], env=dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}",
                                                IFACE="eth0"),
                         start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert p.wait(timeout=5) == 0, "the hook held networkd-dispatcher up"
        deadline = time.monotonic() + 15
        calls = []
        while time.monotonic() < deadline:
            calls = log.read_text().splitlines() if log.exists() else []
            if any("SetHostName" in c for c in calls):
                break
            time.sleep(0.25)
        assert any(c.endswith("SetHostName s fpp-tests") for c in calls), \
            f"avahi's name was not set back: {calls}"
    finally:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def git(*args, cwd=None):
    subprocess.run(["git", "-c", "user.name=fpp-tests", "-c", "user.email=fpp-tests@example.com",
                    "-c", "init.defaultBranch=v1", "-c", "safe.directory=*", *args],
                   cwd=cwd, check=True, capture_output=True)


def version_switch_checkout(sb):
    """An FPP checkout on branch v1 of an origin that has since gained a v2
    branch the checkout hasn't fetched. It holds the tree's scripts/ (the
    upgrade runs the script of the version it upgrades from) and an empty
    upgrade/. Returns the checkout's path here."""
    tmp = os.path.join(sb.media, "tmp")
    origin, work, fpp = (os.path.join(tmp, d) for d in ("origin.git", "work", "fpp"))
    git("init", "-q", "--bare", origin)
    git("clone", "-q", origin, work)
    subprocess.run(["cp", "-a", os.path.join(sb.tree, "scripts"), work], check=True)
    os.makedirs(os.path.join(work, "upgrade"))
    open(os.path.join(work, "upgrade", ".keep"), "w").close()
    git("add", "-A", cwd=work)
    git("commit", "-q", "-m", "v1", cwd=work)
    git("push", "-q", "origin", "HEAD:v1", cwd=work)
    git("clone", "-q", "-b", "v1", origin, fpp)
    git("remote", "set-url", "origin", f"{MEDIA}/tmp/origin.git", cwd=fpp)
    git("commit", "-q", "--allow-empty", "-m", "v2", cwd=work)
    git("push", "-q", "origin", "HEAD:v2", cwd=work)
    return fpp


# We are root already; the test image has no sudo.
SUDO = """#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -*) shift ;; *) break ;; esac; done
exec "$@"
"""


def upgrade_fpp(sb, version):
    """scripts/upgrade_FPP <version> run from the checkout made by
    version_switch_checkout(): FPP finds itself from the script's path, so
    that checkout is the FPP being upgraded, by the path a user checkout
    takes (sudo -u fpp, here the shim). Never at /opt/fpp, which in the
    sandbox is the tree under test: the script cleans and rebuilds the FPP
    it upgrades. With no network: it would otherwise download a compiler
    cache and call this machine's web UI."""
    sb.root_file("/usr/bin/sudo", SUDO)
    fppd = os.path.join(sb.tree, "src", "fppd")
    before = os.stat(fppd).st_mtime_ns
    r = sb._run(["unshare", "--net", f"{MEDIA}/tmp/fpp/scripts/upgrade_FPP", version], timeout=300)
    assert os.stat(fppd).st_mtime_ns == before, "upgrade_FPP rebuilt the tree under test"
    return r


def test_upgrade_fpp_switches_to_a_branch_made_since_the_last_fetch(fppinit):
    """upgrade_FPP switches to a release branch that appeared on origin
    after the device last fetched (v10.1 -> v10.2).

    Regression: b932497cc. It checked the branch out before fetching, and
    git can only make a local branch from an origin/<branch> it already
    has: "pathspec did not match", and the old branch was rebuilt.
    """
    fpp = version_switch_checkout(fppinit)
    r = upgrade_fpp(fppinit, "v2")
    with open(os.path.join(fpp, ".git", "HEAD")) as f:
        head = f.read().strip()
    assert head == "ref: refs/heads/v2", f"still on {head}:\n{(r.stdout + r.stderr)[-3000:]}"


def test_upgrade_fpp_keeps_one_safe_directory_line(fppinit):
    """Each update leaves /etc/gitconfig with one safe.directory line for
    /opt/fpp, and collapses the copies earlier updates added.

    Regression: 7768ee8a3. Every update ran `git config --system --add`,
    so each one appended another copy; long-lived boxes had hundreds.
    """
    version_switch_checkout(fppinit)
    fppinit.root_file("/etc/gitconfig", "[safe]\n\tdirectory = /opt/fpp\n\tdirectory = /opt/fpp\n"
                                        "\tdirectory = *\n")
    r = upgrade_fpp(fppinit, "v2")
    cfg = fppinit.written("/etc/gitconfig") or ""
    lines = [l.strip() for l in cfg.splitlines()]
    assert "directory = /opt/fpp" in lines, f"no safe.directory for /opt/fpp:\n{cfg}\n{(r.stdout + r.stderr)[-2000:]}"
    assert lines.count("directory = /opt/fpp") == 1, f"/etc/gitconfig:\n{cfg}"
    assert lines.count("directory = *") == 1, f"/etc/gitconfig:\n{cfg}"


def test_installer_systemctl_wrapper_passes_global_mask(tmp_path):
    """FPP_Install.sh's systemctl wrapper (used where systemd isn't
    running: the image builds' chroot) passes `systemctl --global mask`
    through to systemctl, as it does a plain `mask`.

    Regression: f842a9f0a. The wrapper dispatched on $1, which is
    "--global" here, so the call fell to "skipping systemctl" and images
    built since 0efdfecae shipped without the per-user PipeWire masks.
    """
    with open(os.path.join(TREE, "SD", "FPP_Install.sh")) as f:
        src = f.read()
    m = re.search(r"^if \[ ! -d /run/systemd/system \]; then\n(.*?)^fi$", src, re.M | re.S)
    assert m and "systemctl()" in m.group(1), "no systemctl wrapper found in FPP_Install.sh"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls"
    (bin_dir / "systemctl").write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> {log}\n")
    (bin_dir / "systemctl").chmod(0o755)
    script = (f"PATH={bin_dir}:$PATH\n{m.group(1)}\n"
              "systemctl enable fpp-tests.service\n"
              "systemctl --global mask pipewire.socket pipewire.service\n")
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
    calls = log.read_text().splitlines() if log.exists() else []
    assert any("enable fpp-tests.service" in c for c in calls), \
        f"the wrapper didn't pass even a plain enable through, so this proves nothing: {calls}\n{r.stdout}"
    assert any("--global" in c and "mask pipewire.socket pipewire.service" in c for c in calls), \
        f"`systemctl --global mask` never reached systemctl: {calls}\n{r.stdout}"
