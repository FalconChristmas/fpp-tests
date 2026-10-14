"""Run one fppinit action against a throwaway copy of the system.

fppinit is FPP's boot-time setup tool: it reads /home/fpp/media and writes
/etc, /boot/firmware and the media config, and runs systemctl, modprobe,
amixer, reboot and the like. A sandbox runs the real binary from the tree
under test with none of that reaching the machine:

- the root filesystem is an overlay whose writes land in a scratch upper
  directory -- read back with written();
- the media directory is one the scenario fills, passed in FPP_MEDIA_DIR
  (so /home/fpp/media is never touched), and /boot/firmware is another;
- /dev holds only null/zero/random/urandom/full, /sys is read-only, /run
  and /tmp are empty, and the action runs in its own PID namespace, so it
  can't see a disk, a bus or another process;
- commands with side effects outside the filesystem are stubs that record
  their arguments (calls()) and succeed;
- the capabilities to load a module, reboot, set the clock or do raw I/O
  are dropped, so a command missing from the stub list fails instead.

Needs root and mount/PID namespaces: run-local.sh has both. Skipped where
they can't be made (a container without CAP_SYS_ADMIN).
"""

import json
import os
import shlex
import shutil
import subprocess
import tempfile

import pytest

# Run for their effect on the system, not the filesystem: stubbed.
STUBS = [
    "systemctl", "journalctl", "modprobe", "rmmod", "insmod", "depmod", "reboot", "shutdown",
    "poweroff", "halt", "amixer", "aplay", "arecord", "alsactl", "udevadm", "pkill", "killall",
    "timedatectl", "hostnamectl", "hostname", "nmcli", "iw", "iwconfig", "wpa_cli", "ifup",
    "ifdown", "dhclient", "rfkill", "hwclock", "i2cdetect", "i2cget", "i2cset", "fdisk", "sfdisk",
    "parted", "resize2fs", "growpart", "mount", "umount", "pw-cli", "pw-dump", "pactl", "wpctl",
    "vcgencmd", "raspi-config", "rpi-eeprom-config", "apt-get", "dpkg", "update-rc.d",
    "a2enmod", "a2dismod", "apachectl", "ssh-keygen", "chpasswd", "setfont",
]

DEVICES = ["null", "zero", "random", "urandom", "full"]

MEDIA = "/fpp-test-media"  # where the media directory appears to fppinit


def _stub(log):
    return ("#!/bin/sh\n"
            f"printf '%s\\n' \"$(basename \"$0\") $*\" >> {log}\n"
            "exit 0\n")


# systemctl answers from, and updates, a state directory: is-active and
# is-enabled report what a scenario set with service() (or what an earlier
# call in the run changed), so fppinit's decisions can be steered and its
# stop/start/enable calls checked in order.
SYSTEMCTL = r"""#!/bin/sh
printf '%s\n' "systemctl $*" >> /fppinit-calls.log
S=/fppinit-state
verb=
rc=0
for a in "$@"; do
    case "$a" in
        -*) continue ;;
    esac
    if [ -z "$verb" ]; then verb=$a; continue; fi
    n=${a%.service}
    case "$verb" in
        is-active)
            st=$(cat "$S/$n.active" 2>/dev/null || echo inactive); echo "$st"
            [ "$st" = active ] || rc=3 ;;
        is-enabled)
            st=$(cat "$S/$n.enabled" 2>/dev/null || echo disabled); echo "$st"
            [ "$st" = enabled ] || rc=1 ;;
        stop|kill) echo inactive > "$S/$n.active" ;;
        start|restart|reload-or-restart|try-restart) echo active > "$S/$n.active" ;;
        enable) echo enabled > "$S/$n.enabled" ;;
        disable|mask) echo disabled > "$S/$n.enabled" ;;
    esac
done
exit $rc
"""


class FppinitSandbox:
    def __init__(self, tree):
        self.tree = os.path.realpath(tree)
        self.dir = tempfile.mkdtemp(prefix="fppinit-")
        self.media = os.path.join(self.dir, "media")
        self.boot = os.path.join(self.dir, "boot")
        for d in ("config", "logs", "tmp", "music", "sequences", "playlists", "plugins",
                  "scripts", "upload", "videos", "images", "effects", "plugindata"):
            os.makedirs(os.path.join(self.media, d))
        os.makedirs(self.boot)
        self.state = os.path.join(self.dir, "state")
        os.makedirs(self.state)
        self.upper = None

    def write(self, rel, content):
        """Write a file into the sandbox's media directory (JSON for a dict
        or list)."""
        path = os.path.join(self.media, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(json.dumps(content, indent=2) if isinstance(content, (dict, list)) else content)

    def service(self, name, enabled=None, active=None):
        """The state the stubbed systemctl starts this run with for a unit."""
        for what, value, yes, no in (("enabled", enabled, "enabled", "disabled"),
                                     ("active", active, "active", "inactive")):
            if value is not None:
                with open(os.path.join(self.state, f"{name}.{what}"), "w") as f:
                    f.write((yes if value else no) + "\n")

    def settings(self, **kv):
        with open(os.path.join(self.media, "settings"), "a") as f:
            for k, v in kv.items():
                f.write(f'{k} = "{v}"\n')

    def run(self, action, *args, timeout=120):
        """Run `fppinit <action> <args>` in a fresh sandbox. Returns the
        CompletedProcess; output and exit status are the caller's to judge."""
        return self._run(["/opt/fpp/src/fppinit", action, *args], timeout=timeout)

    def capedetect(self, *args, timeout=120):
        """Run `fppcapedetect <args>` in a fresh sandbox, as fppinit's
        detectCape step does. CapeUtils names /home/fpp/media throughout
        rather than taking FPP_MEDIA_DIR, so for this run the media
        directory is mounted there as well. The sandbox has no i2c device,
        so the only cape found is a virtual one in config/cape-eeprom.bin."""
        if not os.path.exists(os.path.join(self.tree, "src", "fppcapedetect")):
            pytest.skip("no fppcapedetect in the tree under test (not built in a container)")
        return self._run(["/opt/fpp/src/fppcapedetect", *args], timeout=timeout, media_home=True)

    def _run(self, argv, timeout=120, media_home=False):
        run_dir = tempfile.mkdtemp(prefix="run-", dir=self.dir)
        self.upper = os.path.join(run_dir, "upper")
        root = os.path.join(run_dir, "root")
        work = os.path.join(run_dir, "work")
        for d in (self.upper, root, work):
            os.makedirs(d)
        log = "/fppinit-calls.log"
        stub_lines = []
        systemctl = shutil.which("systemctl", path="/usr/bin:/bin") or "/usr/bin/systemctl"
        for name in STUBS:
            if name == "systemctl":
                continue
            # The command's own path, not what it links to: on systemd
            # systems reboot/poweroff/halt are links to systemctl.
            path = shutil.which(name, path="/usr/sbin:/usr/bin:/sbin:/bin")
            if path:
                stub_lines.append(f"stub {shlex.quote(path)}")
        home = ""
        if media_home:
            home = f'mkdir -p "$R/home/fpp/media"; mount --bind {shlex.quote(self.media)} "$R/home/fpp/media"'
        script = f"""
set -e
R={shlex.quote(root)}
mount -t overlay overlay -o lowerdir=/,upperdir={shlex.quote(self.upper)},workdir={shlex.quote(work)} "$R"
mount -t tmpfs -o mode=755 tmpfs "$R/dev"
for d in {' '.join(DEVICES)}; do touch "$R/dev/$d"; mount --bind "/dev/$d" "$R/dev/$d"; done
ln -s /proc/self/fd "$R/dev/fd"
mount -t proc proc "$R/proc"
mount --bind "$R/proc/sys" "$R/proc/sys"; mount -o remount,bind,ro "$R/proc/sys"
mount --bind /dev/null "$R/proc/sysrq-trigger"
mount --rbind /sys "$R/sys"; mount -o remount,bind,ro "$R/sys"
mount -t tmpfs tmpfs "$R/run"
mount -t tmpfs -o mode=1777 tmpfs "$R/tmp"
mkdir -p "$R{MEDIA}" "$R/boot/firmware" "$R/opt/fpp"
mount --bind {shlex.quote(self.media)} "$R{MEDIA}"
mount --bind {shlex.quote(self.boot)} "$R/boot/firmware"
mount --bind {shlex.quote(self.tree)} "$R/opt/fpp"
{home}
stub() {{ rm -f "$R$1"; printf '%s' {shlex.quote(_stub(log))} > "$R$1"; chmod 755 "$R$1"; }}
mkdir -p "$R/fppinit-state"; cp -a {shlex.quote(self.state)}/. "$R/fppinit-state/"
{chr(10).join(stub_lines)}
rm -f "$R{systemctl}"; printf '%s' {shlex.quote(SYSTEMCTL)} > "$R{systemctl}"; chmod 755 "$R{systemctl}"
: > "$R{log}"
set +e
chroot "$R" setpriv --bounding-set -sys_module,-sys_boot,-sys_time,-sys_rawio \\
    --inh-caps -sys_module,-sys_boot,-sys_time,-sys_rawio \\
    {' '.join(shlex.quote(a) for a in argv)}
rc=$?
# This shell is PID 1 here, and its exit kills whatever is left in the
# namespace -- including fppinit's log writer (teeOutput), still draining.
# Give the stragglers up to 5 s to finish.
n=0
while [ $n -lt 100 ] && [ "$(ls /proc | grep -c '^[0-9]')" -gt 2 ]; do sleep 0.05; n=$((n + 1)); done
exit $rc
"""
        probe = subprocess.run(["unshare", "--mount", "--pid", "--fork", "true"],
                               capture_output=True)
        if probe.returncode:
            pytest.skip("cannot make mount/PID namespaces here: "
                        + probe.stderr.decode(errors="replace").strip())
        env = dict(os.environ)
        env.pop("LD_PRELOAD", None)
        env.setdefault("ASAN_OPTIONS", "detect_leaks=0")
        env["FPP_MEDIA_DIR"] = MEDIA
        return subprocess.run(["unshare", "--mount", "--pid", "--fork", "--mount-proc",
                               "--propagation", "private",
                               "sh", "-c", script], capture_output=True, text=True,
                              timeout=timeout, env=env)

    def written(self, path):
        """What the last run left at an absolute path outside the media and
        boot directories (None if it didn't write it)."""
        p = os.path.join(self.upper, path.lstrip("/"))
        if os.path.isfile(p):
            with open(p, errors="replace") as f:
                return f.read()
        return None

    def calls(self):
        """The stubbed commands the last run invoked, one string each."""
        p = os.path.join(self.upper, "fppinit-calls.log")
        if not os.path.exists(p):
            return []
        with open(p) as f:
            return [l.rstrip("\n") for l in f if l.strip()]

    def media_file(self, rel):
        with open(os.path.join(self.media, rel)) as f:
            return f.read()

    def media_exists(self, rel):
        return os.path.lexists(os.path.join(self.media, rel))

    def write_bytes(self, rel, data):
        path = os.path.join(self.media, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def boot_file(self, rel):
        with open(os.path.join(self.boot, rel)) as f:
            return f.read()

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


@pytest.fixture
def fppinit():
    tree = os.environ.get("FPP_TREE")
    if not tree or not os.path.exists(os.path.join(tree, "src", "fppinit")):
        pytest.skip("no fppinit in the tree under test")
    if os.geteuid() != 0:
        pytest.skip("fppinit sandbox needs root")
    sb = FppinitSandbox(tree)
    try:
        yield sb
    finally:
        sb.cleanup()
