"""How scripts/functions rebuilds FPP and its plugins: the "Distributed
Compile" developer settings (distcc, nocc) that SetupBuildEnv turns into
the build's environment, what the makefiles every plugin includes
(src/makefiles/common/setup.mk) then do with it, and compileBinaries
running the plugin builds through sudo.

SetupBuildEnv only reads the settings file, so it runs straight from the
tree; compileBinaries runs in the fppinit sandbox (fppinit.py) with make
and sudo replaced by stand-ins that record their calls.
"""

import os
import subprocess

import pytest

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture

TREE = os.environ.get("FPP_TREE", "")


def build_env(tmp_path, **settings):
    """SetupBuildEnv's exports and BUILD_CPUS for a settings file holding
    `settings`, as compileBinaries calls it."""
    cfg = tmp_path / "settings"
    cfg.write_text("".join(f'{k} = "{v}"\n' for k, v in settings.items()))
    names = ["DISTCC_HOSTS", "NOCC_SERVERS", "NOCC_GO_EXECUTABLE", "CCACHE_PREFIX", "BUILD_CPUS"]
    script = (f". {TREE}/scripts/common; . {TREE}/scripts/functions; SetupBuildEnv >/dev/null; "
              + "; ".join(f'echo "{n}=${{{n}-<unset>}}"' for n in names))
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60,
                       env=dict(os.environ, FPPDIR=TREE, CFGFILE=str(cfg)))
    assert r.returncode == 0, r.stderr[-2000:]
    return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)


def plugin_make(tmp_path, env):
    """What a plugin's makefile sees after including setup.mk, with the
    build environment `env` (only the variables given; a clean slate
    otherwise): the compiler launcher and the compile flags."""
    mk = tmp_path / "Makefile"
    mk.write_text(f"SRCDIR := {TREE}/src\n"
                  "include $(SRCDIR)/makefiles/common/setup.mk\n"
                  "show:\n\t@echo 'CCACHE=$(CCACHE)'; echo 'CFLAGS=$(CFLAGS)'; "
                  "echo \"GO=$$NOCC_GO_EXECUTABLE\"\n")
    base = {k: v for k, v in os.environ.items()
            if k not in ("DISTCC_HOSTS", "NOCC_SERVERS", "NOCC_DISCOVER_MDNS", "NOCC_GO_EXECUTABLE")}
    r = subprocess.run(["make", "-s", "-f", str(mk), "show"], capture_output=True, text=True,
                       timeout=60, cwd=tmp_path, env=dict(base, **env))
    assert r.returncode == 0, r.stdout[-1000:] + r.stderr[-2000:]
    return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)


def test_distcc_setting_builds_through_distcc_without_the_pch(tmp_path):
    """With the developer setting on distcc and Compile Hosts set, the build
    environment carries DISTCC_HOSTS as given, and the makefiles then drop the precompiled header (which
    distcc can't ship) for -DNOPCH. The old checkbox settings (DistccEnabled)
    still mean the same until the config migration replaces them.

    Regression: 08eb242a2. The distcc developer settings and the makefile's
    reaction to DISTCC_HOSTS were added there; before it a rebuild from the
    UI always compiled locally, with the PCH.
    """
    hosts = "helper-a:3632/6,lzo helper-b/2"
    for settings in ({"DistributedCompile": "distcc", "DistccHosts": hosts},
                     {"DistccEnabled": "1", "DistccHosts": hosts}):
        env = build_env(tmp_path, **settings)
        assert env["DISTCC_HOSTS"] == hosts, (settings, env)
        assert env["NOCC_SERVERS"] == "<unset>", env
    off = build_env(tmp_path, DistributedCompile="off", DistccHosts=hosts)
    assert off["DISTCC_HOSTS"] == "<unset>", off

    flags = plugin_make(tmp_path, {"DISTCC_HOSTS": hosts})["CFLAGS"].split()
    assert "-DNOPCH" in flags and "-Winvalid-pch" not in flags, flags
    local = plugin_make(tmp_path, {})["CFLAGS"].split()
    assert "-DNOPCH" not in local, "a local build lost the PCH too"


def test_nocc_setting_builds_through_nocc_without_the_pch(tmp_path):
    """With the developer setting on nocc and Compile Hosts set, the build
    environment names the helpers in NOCC_SERVERS and the nocc daemon in
    NOCC_GO_EXECUTABLE, and the makefiles then use nocc as the compiler
    launcher and drop the precompiled header.

    Regression: 32e319343. nocc was wired into the build there; before it
    the setting had no nocc mode and the makefiles knew nothing of
    NOCC_SERVERS, so a nocc build compiled locally with the PCH.
    """
    env = build_env(tmp_path, DistributedCompile="nocc", DistccHosts="helper-a:43210")
    assert env["NOCC_SERVERS"] == "helper-a:43210", env
    assert env["NOCC_GO_EXECUTABLE"] == "/usr/bin/nocc-daemon", env
    assert env["DISTCC_HOSTS"] == "<unset>", env

    got = plugin_make(tmp_path, {"NOCC_SERVERS": env["NOCC_SERVERS"]})
    assert got["CCACHE"] == "nocc", got
    assert got["GO"] == "/usr/bin/nocc-daemon", got
    flags = got["CFLAGS"].split()
    assert "-DNOPCH" in flags and "-Winvalid-pch" not in flags, flags


def test_nocc_gets_the_compile_hosts_as_host_port_pairs(tmp_path):
    """The Compile Hosts field is shared with distcc (space-separated,
    host[:port][/jobs][,options]); for nocc it becomes the ';'-separated
    host:port list nocc requires, a bare host getting nocc's port 43210.

    Regression: f2b0d0cf3. The field went to NOCC_SERVERS as typed: nocc
    split "a b/4,lzo" on ';' into one host named "a b/4,lzo" with no port,
    and every compile failed over to the local machine.
    """
    env = build_env(tmp_path, DistributedCompile="nocc", DistccHosts="a b/4,lzo c:1234")
    assert env["NOCC_SERVERS"] == "a:43210;b:43210;c:1234", env


PLUGIN = f"{MEDIA}/plugins/fpp-tests-native"

# sudo as the sandbox has it (it runs its command as is), recording the call.
RECORDING_SUDO = """#!/bin/sh
printf '%s\\n' "sudo $*" >> /fppinit-calls.log
while [ $# -gt 0 ]; do
    case "$1" in
        -u|-g|-p|-C|-h|-r|-t|-U) shift 2 ;;
        --) shift; break ;;
        -*) shift ;;
        *) break ;;
    esac
done
exec env "$@"
"""

# make, recording the call; building a plugin leaves a file behind in it.
RECORDING_MAKE = """#!/bin/sh
printf '%s\\n' "make $*" >> /fppinit-calls.log
if [ "$1" = -C ] && [ "$3" = -f ]; then
    case " $* " in *" clean "*) ;; *) touch "$2/built.so" ;; esac
fi
exit 0
"""


def test_plugins_are_cleaned_built_and_chowned_through_sudo(fppinit):
    """compileBinaries in /opt/fpp (an update or branch change from the UI,
    run as the fpp user) cleans and builds each plugin with a Makefile
    through sudo, as it does FPP itself, and hands what the build made back
    to fpp with a chown that also goes through sudo.

    Regression: 8b1735ea9 (make) and fd9e5dc00 (chown). The plugin make
    ran as the calling user, so a plugin whose earlier build was root's
    couldn't be cleaned or rebuilt; and the chown added to undo root's
    build ran without sudo, which as fpp fails on root's files.
    """
    fppinit.unstub("mount")
    fppinit.write("plugins/fpp-tests-native/Makefile", "all:\n")
    fppinit.root_file("/usr/bin/sudo", RECORDING_SUDO)
    fppinit.root_file("/usr/bin/make", RECORDING_MAKE)
    # The tree's www/media_root.txt names whichever media directory fppd
    # last ran with; point it at the sandbox's, inside the sandbox only.
    r = fppinit._run(["bash", "-c",
                      f"echo {MEDIA} > /tmp/media_root.txt && "
                      "mount --bind /tmp/media_root.txt /opt/fpp/www/media_root.txt && "
                      "export FPPDIR=/opt/fpp && . /opt/fpp/scripts/common && . /opt/fpp/scripts/functions && "
                      "compileBinaries; echo \"compileBinaries exited $?\""], timeout=120)
    out = r.stdout + r.stderr
    assert "compileBinaries exited 0" in out, out[-3000:]
    calls = fppinit.calls()
    plugin = [c for c in calls if PLUGIN in c]
    assert f"Building plugin {PLUGIN}" in out, f"the plugin was not built:\n{out[-3000:]}"
    sudo_make = [c for c in plugin if c.startswith("sudo ") and f"make -C {PLUGIN}" in c]
    assert any(" clean" in c for c in sudo_make), f"plugin clean not through sudo: {plugin}"
    assert any(" clean" not in c for c in sudo_make), f"plugin build not through sudo: {plugin}"
    chown = [c for c in plugin if "chown" in c]
    assert chown and all(c.startswith("sudo ") for c in chown), f"chown not through sudo: {plugin}"
    assert os.path.exists(os.path.join(fppinit.media, "plugins/fpp-tests-native/built.so")), plugin
