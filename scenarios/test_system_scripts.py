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

import pytest

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

    Regression: 1b9619123. gracefullyReloadApacheConf returned 1 when apache2
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

    Regression: 91e4b1539. cfa731d71 fixed the hook in the tree, but only an
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


def test_the_chrony_reconnect_hook_steps_only_inside_a_clock_update(fppinit):
    """The routable.d chrony hook, on a runtime reconnect (fppd running),
    re-arms chrony's automatic step ("makestep 1.0 3") before bringing the
    sources online and bursting, and never runs a bare "chronyc makestep".

    Regression: cfa731d71. The hook bursted and then ran a bare makestep,
    which stepped the leftover slew outside a clock update; any step clears
    the kernel's NTP state, so timedatectl and the Health Check reported
    "not synchronized" for up to ~68 minutes while chrony was in sync.
    """
    fppinit.root_file("/usr/bin/chronyc", _stub(CALLS))
    fppinit.root_file("/usr/bin/pgrep", "#!/bin/sh\nexit 0\n")  # fppd is running: a reconnect
    r = fppinit._run(["sh", "/opt/fpp/etc/networkd-dispatcher/routable.d/chrony"])
    assert r.returncode == 0, r.stdout + r.stderr
    chronyc = [c.split(None, 1)[1] if " " in c else "" for c in fppinit.calls() if c.split()[0] == "chronyc"]
    assert "burst 4/4" in chronyc, f"no burst on a reconnect: {chronyc}"
    assert "makestep" not in chronyc, f"a bare makestep ran: {chronyc}"
    assert "makestep 1.0 3" in chronyc and chronyc.index("makestep 1.0 3") < chronyc.index("burst 4/4"), \
        f"the automatic step was not re-armed before the burst: {chronyc}"


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


def upgrade_fpp(sb, version):
    """scripts/upgrade_FPP <version> run from the checkout made by
    version_switch_checkout(): FPP finds itself from the script's path, so
    that checkout is the FPP being upgraded, by the path a user checkout
    takes (sudo -u fpp, here the sandbox's stand-in). Never at /opt/fpp,
    which in the sandbox is the tree under test: the script cleans and
    rebuilds the FPP it upgrades. With no network: it would otherwise download a compiler
    cache and call this machine's web UI."""
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


def test_install_pipewire_masks_the_user_units_system_wide(tmp_path):
    """install_pipewire.sh's masking step masks every per-user PipeWire
    unit with systemctl --global (/etc/systemd/user), filter-chain included.

    Regression: 0efdfecae. The step linked the units to /dev/null in
    ~fpp/.config/systemd/user, which an fppos upgrade never carries over, so
    a device upgraded that way started a second PipeWire stack at login."""
    with open(os.path.join(TREE, "scripts", "install_pipewire.sh")) as f:
        src = f.read()
    m = re.search(r"^# --- 6\..*?$(.*?)^# --- 7\.", src, re.M | re.S)
    assert m and "Masking user-session PipeWire services" in m.group(1), "no masking step in install_pipewire.sh"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls"
    for cmd in ("systemctl", "chown"):
        (bin_dir / cmd).write_text(f"#!/bin/sh\nprintf '%s\\n' \"{cmd} $*\" >> {log}\n")
        (bin_dir / cmd).chmod(0o755)
    # Anything the step writes under ~fpp lands in tmp_path instead.
    step = m.group(1).replace("/home/fpp", str(tmp_path / "home"))
    r = subprocess.run(["bash", "-c", f"PATH={bin_dir}:$PATH\n{step}"], capture_output=True, text=True, timeout=30)
    calls = log.read_text().splitlines() if log.exists() else []
    masks = [c for c in calls if c.startswith("systemctl") and "--global" in c and " mask " in c]
    assert masks, f"no systemctl --global mask: {calls}\n{r.stdout}{r.stderr}"
    units = set(masks[0].split())
    for unit in ("pipewire.socket", "pipewire.service", "pipewire-pulse.socket",
                 "pipewire-pulse.service", "wireplumber.service", "filter-chain.service"):
        assert unit in units, f"{unit} is not masked: {masks}"


# scripts/git_fetch against stand-ins: git logs its calls and fails a fetch
# between the "fail" and "ok" steps; curl answers as GitHub does except between
# "down" and "up". Each "page" step runs it once, as a page load does; "age S"
# moves each of its stamps S seconds further into the past (negative: into the
# future, as a clock stepped back leaves them).
GIT_FETCH = r"""
cat > /usr/bin/git <<'STUB'
#!/bin/sh
printf '%s\n' "git $*" >> /fppinit-calls.log
case "$*" in
    *"fetch -p -P"*) [ -f /fppinit-state/fetch-fails ] && exit 1 ;;
    branch) echo "* master" ;;
esac
exit 0
STUB
cat > /usr/bin/curl <<'STUB'
#!/bin/sh
[ -f /fppinit-state/github-down ] && exit 7
printf 'HTTP/2 200\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'
STUB
chmod +x /usr/bin/git /usr/bin/curl
for step in "$@"; do
    case "$step" in
        page) env FPPDIR=$FPPDIR $FPPDIR/scripts/git_fetch > /dev/null 2>&1
              echo "fetches: $(grep -c '^git fetch -p -P$' /fppinit-calls.log)" ;;
        down) touch /fppinit-state/github-down ;;
        up) rm -f /fppinit-state/github-down ;;
        fail) touch /fppinit-state/fetch-fails ;;
        ok) rm -f /fppinit-state/fetch-fails ;;
        age*) for f in "$MEDIA"/tmp/git_fetch_*; do
                  [ -f "$f" ] && touch -d "@$(( $(stat -c %Y "$f") - ${step#age } ))" "$f"
              done ;;
    esac
done
"""


def git_fetch_pages(sb, *steps):
    """Runs GIT_FETCH's steps; the number of fetches after each page load."""
    view = fppdir_view(sb)
    r = sb._run(["env", f"FPPDIR={view}", f"MEDIA={MEDIA}", "bash", "-c", GIT_FETCH, "git_fetch",
                 *steps], timeout=120)
    out = r.stdout + r.stderr
    counts = [int(l.split()[1]) for l in out.splitlines() if l.startswith("fetches: ")]
    assert len(counts) == steps.count("page"), out[-3000:]
    return counts, out


def test_git_fetch_on_every_page_load_is_throttled(fppinit):
    """Page loads run scripts/git_fetch; one straight after a fetch does not
    fetch again (FPP_GIT_FETCH_MIN_AGE, 15 minutes), and once that is past
    the next does.

    Regression: 46b2d7b5b. Every page view of About, MultiSync or a branch
    list ran a full fetch of the repo, its tags and every submodule, queued
    behind the last on the repo lock, which kept a Pi Zero W busy for
    minutes."""
    counts, out = git_fetch_pages(fppinit, "page", "page", "page", "age 1000", "page")
    assert counts[0] == 1, f"the first page load did not fetch, so this proves nothing:\n{out[-3000:]}"
    assert counts[1:3] == [1, 1], f"page loads straight after a fetch fetched again: {counts}"
    assert counts[3] == 2, f"a fetch 1000 s old was not repeated: {counts}"


def test_git_fetch_counts_only_a_successful_fetch_as_fresh(fppinit):
    """Only a fetch that worked holds page loads off for 15 minutes. One
    made while GitHub was unreachable, or whose fetch failed, is retried by
    a page load two minutes later (not one straight after); a stamp from
    the future (the clock stepped back) counts as stale.

    Regression: c222a9f90. Any attempt wrote the 15-minute stamp, so the
    first page load after a boot, before DNS was up, turned update checks
    off for 15 minutes; and a stamp newer than the clock gave a negative
    age, which always looked recent."""
    counts, out = git_fetch_pages(
        fppinit,
        "down", "page", "page", "up", "age 120", "page",    # unreachable, retried after 2 minutes
        "age -3600", "page",                                # clock stepped back an hour
        "fail", "age 1000", "page", "page", "ok", "age 120", "page",  # the fetch itself fails
    )
    assert counts[:2] == [0, 0], f"an unreachable GitHub was fetched from:\n{out[-3000:]}"
    assert counts[2] == 1, f"2 minutes after GitHub was unreachable, a page load still did not fetch: {counts}"
    assert counts[3] == 2, f"a fetch stamped an hour in the future stopped page-load fetches: {counts}"
    assert counts[4] == 3, f"a stale fetch was not repeated: {counts}"
    assert counts[5] == 3, f"a page load straight after a failed fetch fetched again: {counts}"
    assert counts[6] == 4, f"2 minutes after a failed fetch, a page load still did not fetch: {counts}"


def setup_nocc_host(sb):
    """scripts/setup_nocc_host.sh with stand-ins for the nocc package (its
    server and env file, mDNS advertising on) and both cross compilers."""
    tools = ["nocc-server"] + [f"{t}-{c}" for t in ("arm-linux-gnueabihf", "aarch64-linux-gnu")
                               for c in ("gcc", "g++")]
    script = "".join(
        f"printf '#!/bin/sh\\necho \"usage: -advertise-mdns -port N\"\\n' > /usr/bin/{t}\n"
        f"chmod +x /usr/bin/{t}\n" for t in tools)
    script += ("mkdir -p /etc/default\n"
               "echo 'NOCC_SERVER_OPTS=\"-advertise-mdns -port 43210\"' > /etc/default/nocc-server\n"
               "bash /opt/fpp/scripts/setup_nocc_host.sh\n"
               "echo \"setup exited $?\"\n")
    r = sb._run(["sh", "-c", script], timeout=120)
    return r.stdout + r.stderr


def test_setup_nocc_host_gets_to_the_next_step(fppinit):
    """With mDNS advertising on (the default), setup_nocc_host.sh starts
    the helper and goes on to print the client instructions, exiting 0.

    Regression: 20301ec26. Under set -u it assigned the never-set
    MDNS_NOTE to itself and died with "unbound variable" after starting the
    helper, before the instructions, exiting non-zero."""
    out = setup_nocc_host(fppinit)
    assert any("restart nocc-server" in c for c in fppinit.calls()), \
        f"the helper was never started, so this proves nothing:\n{out[-3000:]}"
    assert "unbound variable" not in out, out[-3000:]
    assert "NEXT STEP" in out, out[-3000:]
    assert "setup exited 0" in out, out[-3000:]


def test_setup_nocc_host_orders_the_helper_after_postnetwork(fppinit):
    """setup_nocc_host.sh installs a nocc-server drop-in ordering it after
    fpp_postnetwork, before reloading systemd and restarting it.

    Regression: 051d4a374. nocc-server -advertise-mdns reads the interface
    addresses once, at startup, and network-online.target does not wait for
    a DHCP lease: a helper that started early advertised a link-local or
    tether address its clients could not reach."""
    out = setup_nocc_host(fppinit)
    dropin = fppinit.written("/etc/systemd/system/nocc-server.service.d/fpp-after-postnetwork.conf")
    assert dropin is not None, f"no drop-in was installed:\n{out[-3000:]}"
    assert "After=fpp_postnetwork.service" in dropin.splitlines(), dropin
    calls = [c for c in fppinit.calls() if c.startswith("systemctl ")]
    assert "systemctl daemon-reload" in calls, calls
    assert calls.index("systemctl daemon-reload") < calls.index("systemctl restart nocc-server"), calls


# php_security_update against stand-ins: dpkg-query lists php8.4 packages at
# the version in /fppinit-state/php-version, and apt-get's install moves them
# to the one in /fppinit-state/php-candidate, asking the policy-rc.d in place
# (as invoke-rc.d does) whether php8.4-fpm and apache2 may restart.
PHP_STANDINS = r"""
cat > /usr/bin/dpkg-query <<'STUB'
#!/bin/sh
v=$(cat /fppinit-state/php-version)
for p in php8.4-fpm php8.4-cli php8.4-common; do echo "ii  $p php8.4 $v"; done
echo "ii  apache2 apache2 2.4.62-1"
STUB
cat > /usr/bin/apt-get <<'STUB'
#!/bin/sh
printf '%s\n' "apt-get $*" >> /fppinit-calls.log
case " $* " in
    *" install "*)
        for s in php8.4-fpm apache2; do
            if [ -x /usr/sbin/policy-rc.d ]; then
                /usr/sbin/policy-rc.d "$s" restart; echo "policy $s $?" >> /fppinit-calls.log
            else
                echo "policy $s none" >> /fppinit-calls.log
            fi
        done
        cp /fppinit-state/php-candidate /fppinit-state/php-version ;;
esac
exit 0
STUB
chmod +x /usr/bin/dpkg-query /usr/bin/apt-get
"""


def php_update(sb, installed, candidate, command):
    sb.unstub("dpkg")  # its --compare-versions; nothing here installs
    # Debian's container images ship a policy-rc.d that refuses every
    # restart; a device has none, and the script won't replace someone else's.
    sb.root_file("/usr/sbin/policy-rc.d", None)
    with open(os.path.join(sb.state, "php-version"), "w") as f:
        f.write(installed + "\n")
    with open(os.path.join(sb.state, "php-candidate"), "w") as f:
        f.write(candidate + "\n")
    if not os.path.exists(os.path.join(sb.media, "settings")):
        sb.write("settings", "")
    made = os.path.isdir(os.path.join(sb.media, "tmp", "fppdir"))
    view = f"{MEDIA}/tmp/fppdir" if made else fppdir_view(sb)
    r = sb._run(["sh", "-c", PHP_STANDINS + f'{command.replace("/opt/fpp", view)}; echo "exited $?"; '
                 "ls /usr/sbin/policy-rc.d 2>&1"], timeout=120)
    return r.stdout + r.stderr


def test_php_security_update_leaves_php_fpm_running(fppinit):
    """php_security_update upgrades the installed php8.x packages from a
    release without the PHP2Shell fix to one with it. While apt runs, a
    policy-rc.d refuses only php-fpm's restart (an update started from the
    web UI runs inside php-fpm's cgroup, and that restart would kill it);
    the policy is gone afterwards, and the reboot flag is set instead.

    Added in a0aa04d3e: a git update never touched the OS packages, so only
    a new image or fppos brought the fixed PHP."""
    out = php_update(fppinit, "8.4.16-1~deb13u1", "8.4.27-1~deb13u1", "/opt/fpp/scripts/php_security_update")
    calls = fppinit.calls()
    installs = [c for c in calls if c.startswith("apt-get ") and " install " in c]
    assert installs and "--only-upgrade" in installs[0].split(), f"PHP was not upgraded:\n{out[-3000:]}\n{calls}"
    assert "php8.4-fpm" in installs[0].split() and "apache2" not in installs[0].split(), installs
    assert "policy php8.4-fpm 101" in calls, f"php-fpm's restart was not refused: {calls}"
    assert "policy apache2 0" in calls, f"the policy refused more than php-fpm: {calls}"
    assert "exited 0" in out, out[-3000:]
    assert "No such file" in out.split("exited 0", 1)[1], f"the policy-rc.d was left in place:\n{out[-3000:]}"
    assert 'rebootFlag = "1"' in fppinit.media_file("settings"), fppinit.media_file("settings")


def test_upgrade_160_retries_until_the_fixed_php_arrives(fppinit):
    """Where the apt sources don't carry the fixed PHP yet (Raspbian
    publishes it days after Debian), upgrade 160 installs and enables
    fpp-php-security-update.timer to retry; php_security_update --timer,
    once PHP is fixed, turns it off.

    Added in a0aa04d3e."""
    out = php_update(fppinit, "8.4.16-1~deb13u1", "8.4.16-1~deb13u1", "/opt/fpp/upgrade/160/upgrade.sh")
    if "Container - skipping" in out or "No apt-get" in out:
        pytest.skip("upgrade 160 doesn't run here")
    calls = fppinit.calls()
    assert "The apt sources do not carry the fixed PHP yet" in out, out[-3000:]
    assert "systemctl enable --now fpp-php-security-update.timer" in calls, f"no retry was scheduled:\n{out[-3000:]}"
    timer = "/lib/systemd/system/fpp-php-security-update.timer"
    assert fppinit.written(timer) is not None or fppinit.written("/usr" + timer) is not None, calls

    out = php_update(fppinit, "8.4.27-1~deb13u1", "8.4.27-1~deb13u1", "/opt/fpp/scripts/php_security_update --timer")
    assert "exited 0" in out, out[-3000:]
    assert "systemctl disable --now fpp-php-security-update.timer" in fppinit.calls(), out[-3000:]


def test_a_side_install_keeps_the_owners_uid_1000_account(fppinit):
    """FPP_Install.sh's add_fpp_user, run as a side install (no --img) on a
    machine whose UID 1000 is its owner's login: the owner's account and
    home are kept and fpp gets the next free id. The sandbox has a passwd,
    group and shadow of its own for it.

    Regression: 83e270117. The eviction of whatever held UID 1000, meant
    for the stock pi/debian user of an image build, ran in every mode: a
    side install on a NUC or VM ran userdel -r on its owner."""
    with open(os.path.join(TREE, "SD", "FPP_Install.sh")) as f:
        src = f.read()
    m = re.search(r"^add_fpp_user\(\) \{\n.*?^\}$", src, re.M | re.S)
    assert m, "no add_fpp_user() in FPP_Install.sh"
    groups = ["root:x:0:", "adm:x:4:", "dialout:x:20:", "sudo:x:27:", "audio:x:29:", "video:x:44:",
              "users:x:100:", "owner:x:1000:"]
    fppinit.root_file("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\n"
                                     "owner:x:1000:1000:Owner:/home/owner:/bin/bash\n")
    fppinit.root_file("/etc/group", "\n".join(groups) + "\n")
    fppinit.root_file("/etc/shadow", "root:*:20000:0:99999:7:::\nowner:*:20000:0:99999:7:::\n")
    fppinit.root_file("/etc/gshadow", "".join(f"{g.split(':')[0]}:*::\n" for g in groups))
    fppinit.root_file("/home/owner/keep", "the owner's file\n")
    script = f"isimage=false\nFPPUSER=fpp\nFPPHOME=/home/fpp-side-install\n{m.group(0)}\nadd_fpp_user\n" \
             "echo \"owner: $(getent passwd owner)\"\necho \"fpp: $(getent passwd fpp)\"\n" \
             "[ -f /home/owner/keep ] && echo 'owner home kept'\n"
    r = fppinit._run(["bash", "-c", script], timeout=120)
    out = r.stdout + r.stderr
    assert "fpp: fpp:x:" in out, f"no fpp user was made, so this proves nothing:\n{out[-3000:]}"
    assert "owner: owner:x:1000:1000:" in out, f"the owner's UID 1000 account is gone:\n{out[-3000:]}"
    assert "owner home kept" in out, f"the owner's home went with it:\n{out[-3000:]}"
    fpp_uid = re.search(r"^fpp: fpp:x:(\d+):", out, re.M).group(1)
    assert fpp_uid != "1000", out[-3000:]


def test_get_uuid_takes_a_pb2_industrial_serial(tmp_path):
    """get_uuid makes the system UUID from a PocketBeagle 2's EEPROM
    serial when it is an Industrial board's, whose serial carries an "I".
    The script reads files of the scenario's in place of
    /sys/bus/i2c/devices/0-0050/eeprom and of the CPU and device-tree
    serials (none, as on that board).

    Also guards 87b6e674b, which added the board EEPROM read at all.

    Regression: 288d803a3. The serial had to be PB2 and hex digits only,
    so an Industrial board fell through to another, less stable source."""
    with open(os.path.join(TREE, "scripts", "get_uuid")) as f:
        src = f.read()
    assert "/sys/bus/i2c/devices/0-0050/eeprom" in src, "get_uuid no longer reads the board EEPROM"
    serial = "5025PB2I0004A7C1"
    eeprom = tmp_path / "eeprom"
    eeprom.write_bytes(b"\xaa" * 40 + serial.encode() + b"\xff" * 16)
    script = tmp_path / "get_uuid"
    # No CPU or device-tree serial, which come first, as a PocketBeagle 2 has none.
    (tmp_path / "cpuinfo").write_text("processor\t: 0\n")
    script.write_text(src.replace("/sys/bus/i2c/devices/0-0050/eeprom", str(eeprom))
                         .replace("/proc/cpuinfo", str(tmp_path / "cpuinfo"))
                         .replace("/proc/device-tree/serial-number", str(tmp_path / "no-serial")))
    # Not a container (the scenario's is one), where get_uuid skips the hardware.
    r = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=30,
                       cwd=tmp_path, env=dict(os.environ, FPPDIR=TREE, FPP_DOCKERENV=str(tmp_path / "no-dockerenv"),
                                          FPP_CONTAINERFILE=str(tmp_path / "no-container")))
    assert r.stdout.strip() == f"M5-{serial}", f"get_uuid gave {r.stdout.strip()!r}\n{r.stderr[-2000:]}"


def test_kiosk_starts_chromium_browser_where_there_is_no_chromium(fppinit):
    """start_kiosk.sh launches chromium-browser in kiosk mode on an older
    OS that has it rather than chromium, and logs an error when neither is
    there. X's tools and the browser are stubs that record their calls.

    Regression: 01d2b4618. It ran chromium, which only trixie has. Also
    guards 4a09bd2cb, which put start_kiosk.sh back after the scripts
    cleanup deleted it."""
    stubs = "".join(f"printf '#!/bin/sh\\nprintf \"%%s\\\\n\" \"{t} $*\" >> /fppinit-calls.log\\n' > /usr/bin/{t}; "
                    f"chmod +x /usr/bin/{t}; " for t in ("xset", "setxkbmap", "xrandr", "chromium-browser"))
    fppinit.root_file("/usr/bin/chromium", None)
    fppinit.write("settings", "")
    r = fppinit._run(["sh", "-c", stubs + "mkdir -p /root/.config/chromium/Default; "
                      "HOME=/root bash /opt/fpp/scripts/start_kiosk.sh; echo \"exited $?\""],
                     timeout=60, media_home=True)
    out = r.stdout + r.stderr
    launches = [c for c in fppinit.calls() if c.startswith(("chromium", "chromium-browser"))]
    assert launches and launches[0].startswith("chromium-browser ") and "--kiosk" in launches[0], \
        f"no chromium-browser kiosk was started: {fppinit.calls()}\n{out[-2000:]}"
