"""FPP's version, branch and plugin scripts given arguments they should
refuse, and the version switches they must still make, in the fppinit
sandbox (fppinit.py).

The web pages that call these validate their input first, but the scripts
run as root and some of their inputs are files anyone can write (media/tmp)
or values a plugin passes through, so they check again. Each run here is
against an FPP checkout made in the media directory (never /opt/fpp, which
in the sandbox is the tree under test), with no network.
"""

import os
import subprocess

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_system_scripts import fppdir_view, git, upgrade_fpp, version_switch_checkout

CHECKOUT = f"{MEDIA}/tmp/fpp"

# A stand-in for FPP's src/Makefile: logs each target it is asked for.
MAKEFILE = f"""all:
\t@echo "make all" >> {MEDIA}/tmp/make.log
Makefile: ;
%:
\t@echo "make $@" >> {MEDIA}/tmp/make.log
"""


def made(sb):
    return sb.media_file("tmp/make.log").split("\n") if sb.media_exists("tmp/make.log") else []


def checkout_with_src(sb):
    """version_switch_checkout(), with a src/Makefile on v1 that only logs."""
    fpp = version_switch_checkout(sb)
    os.makedirs(os.path.join(fpp, "src"))
    with open(os.path.join(fpp, "src", "Makefile"), "w") as f:
        f.write(MAKEFILE)
    git("add", "-A", cwd=fpp)
    git("commit", "-q", "-m", "src", cwd=fpp)
    return fpp


def head(fpp):
    return subprocess.run(["git", "-c", "safe.directory=*", "-C", fpp, "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()


def run_script(sb, script, *args, timeout=300):
    r = sb._run(["unshare", "--net", f"{CHECKOUT}/scripts/{script}", *args],
                timeout=timeout, media_home=True)
    return r, r.stdout + r.stderr


def test_git_checkout_version_refuses_an_option_shaped_version(fppinit):
    """scripts/git_checkout_version takes a commit; "-q" is refused before
    git or make see it.

    Regression: a12809f46. The version went unquoted into git show and git
    checkout, and on to a rebuild.
    """
    fpp = checkout_with_src(fppinit)
    fppinit.root_file("/etc/fpp/container", None)
    before = head(fpp)
    r, out = run_script(fppinit, "git_checkout_version", "-q")
    assert "Invalid version" in out, out[-3000:]
    assert r.returncode == 1, out[-3000:]
    assert made(fppinit) == [], f"make ran: {made(fppinit)}"
    assert head(fpp) == before


def test_git_checkout_version_from_a_detached_head_with_no_saved_branch(fppinit):
    """git_checkout_version switches a detached checkout to the commit it is
    given and rebuilds, though media/tmp/gitbranch (where it remembers the
    branch it left) is gone -- as after a reboot, which clears tmp.

    Regression: 8b45c172e. a12809f46 checked the saved branch against the
    same allow-list as the version, and an empty one failed it: "Invalid
    branch ''", and no version could be checked out from a detached HEAD.
    """
    fpp = checkout_with_src(fppinit)
    fppinit.root_file("/etc/fpp/container", None)
    target = head(fpp)
    git("commit", "-q", "--allow-empty", "-m", "later", cwd=fpp)
    git("checkout", "-q", "--detach", cwd=fpp)
    assert not fppinit.media_exists("tmp/gitbranch")
    r, out = run_script(fppinit, "git_checkout_version", target)
    assert "Invalid branch" not in out, out[-3000:]
    assert head(fpp) == target, f"not switched to {target}:\n{out[-3000:]}"
    assert "make optimized" in made(fppinit), f"no rebuild: {made(fppinit)}\n{out[-3000:]}"
    assert r.returncode == 0, out[-3000:]


def test_upgrade_fpp_refuses_a_version_that_is_shell_text(fppinit):
    """upgrade_FPP refuses a version that isn't a ref name, before it stops
    fppd or cleans anything, and none of it is run.

    Regression: fc9702bca. The version was pasted into the command string
    runGitLocked hands to bash -c, so "x;touch ..." ran as root.
    """
    fpp = checkout_with_src(fppinit)
    before = head(fpp)
    r = upgrade_fpp(fppinit, "x;touch${IFS}/fpp-test-media/pwned")
    out = r.stdout + r.stderr
    assert not fppinit.media_exists("pwned"), f"the version was run as shell:\n{out[-3000:]}"
    assert "Invalid version" in out and r.returncode == 1, out[-3000:]
    assert made(fppinit) == [], f"make ran: {made(fppinit)}"
    assert head(fpp) == before


def test_git_branch_refuses_a_branch_that_is_shell_text(fppinit):
    """scripts/git_branch refuses a branch name with shell text in it, even
    one that matches a real branch's name, and none of it is run.

    Regression: fc9702bca. The name only had to match a remote ref by grep
    -i, and went on into the bash -c command string: "v2\\|$(...)" matched
    v2 and ran the $(...) as root.
    """
    fpp = checkout_with_src(fppinit)
    before = head(fpp)
    r, out = run_script(fppinit, "git_branch", "v2\\|$(touch${IFS}/fpp-test-media/pwned)")
    assert not fppinit.media_exists("pwned"), f"the branch was run as shell:\n{out[-3000:]}"
    assert "Invalid branch name" in out and r.returncode == 1, out[-3000:]
    assert head(fpp) == before


def test_a_failed_version_switch_is_reported(fppinit):
    """upgrade_FPP to a version that can't be checked out exits non-zero and
    says it failed, though it still rebuilds the branch it is on (the old
    binaries are already cleaned by then).

    Regression: 2f0a7fdf5. runGitLocked's status was discarded: the failed
    checkout (the Upgrade button's "vv10.1") rebuilt the old branch in place
    and reported "Upgrade complete".
    """
    fpp = checkout_with_src(fppinit)
    before = head(fpp)
    r = upgrade_fpp(fppinit, "vvnope")
    out = r.stdout + r.stderr
    assert head(fpp) == before
    assert "make optimized" in made(fppinit) or "make all" in made(fppinit), \
        f"the current branch was not rebuilt: {made(fppinit)}\n{out[-3000:]}"
    assert "upgrade to 'vvnope' FAILED" in out, out[-3000:]
    assert r.returncode == 1, f"exited {r.returncode} after a failed switch:\n{out[-3000:]}"


def test_a_version_switch_stops_fppd_through_systemd(fppinit):
    """upgrade_FPP stops fppd with "systemctl stop fppd" before it deletes
    and rebuilds the binary, so systemd knows the stop is intended.

    Regression: d7f7ea0c2. It ran fppd_stop directly; fppd.service's
    Restart=always then restarted fppd against the missing binary through
    the whole rebuild, used up its restart burst and left the unit failed.
    """
    checkout_with_src(fppinit)
    fppinit.root_file("/etc/fpp/container", None)  # a container has no systemd fppd
    r = upgrade_fpp(fppinit, "v2")
    out = r.stdout + r.stderr
    assert "systemctl stop fppd" in fppinit.calls(), f"{fppinit.calls()}\n{out[-3000:]}"
    assert "make clean" in made(fppinit), made(fppinit)


def test_switching_to_a_pr_keeps_its_ref_through_a_pruning_fetch(fppinit):
    """git_branch pr-<n> registers a fetch refspec for that pull request, so
    a later "git fetch -p" (the background git_fetch) keeps the PR's ref and
    the branch keeps its upstream; switching back to a plain branch removes
    the refspec again.

    Regression: a62dad569. refs/remotes/origin/pull/<n>/head is outside the
    default refspec, so every pruning fetch deleted it: "upstream is gone"
    until the next git_pull.
    """
    fpp = checkout_with_src(fppinit)
    work = os.path.join(fppinit.media, "tmp", "work")
    git("commit", "-q", "--allow-empty", "-m", "pr 7", cwd=work)
    git("push", "-q", "origin", "HEAD:refs/pull/7/head", cwd=work)
    spec = "+refs/pull/7/head:refs/remotes/origin/pull/7/head"

    r, out = run_script(fppinit, "git_branch", "pr-7")
    with open(os.path.join(fpp, ".git", "HEAD")) as f:
        assert f.read().strip() == "ref: refs/heads/pr-7", out[-3000:]
    fetch = subprocess.run(["git", "-c", "safe.directory=*", "-C", fpp, "config", "--get-all",
                            "remote.origin.fetch"], capture_output=True, text=True).stdout.split()
    assert spec in fetch, f"remote.origin.fetch: {fetch}\n{out[-3000:]}"

    r = fppinit._run(["git", "-c", "safe.directory=*", "-C", CHECKOUT, "fetch", "-p", "-P"])
    assert r.returncode == 0, r.stdout + r.stderr
    upstream = subprocess.run(["git", "-c", "safe.directory=*", "-C", fpp, "rev-parse",
                               "--abbrev-ref", "pr-7@{u}"], capture_output=True, text=True)
    assert upstream.returncode == 0 and upstream.stdout.strip() == "origin/pull/7/head", \
        f"the PR's upstream is gone after a pruning fetch: {upstream.stderr}"

    r, out = run_script(fppinit, "git_branch", "v2")
    fetch = subprocess.run(["git", "-c", "safe.directory=*", "-C", fpp, "config", "--get-all",
                            "remote.origin.fetch"], capture_output=True, text=True).stdout.split()
    assert spec not in fetch and fetch, f"remote.origin.fetch after leaving the PR: {fetch}\n{out[-3000:]}"


def test_os_upgrade_refuses_an_image_outside_the_upload_directory(fppinit):
    """upgradeOS-part1.sh only takes an image from media/upload, where the
    UI puts one, and refuses any other path before it mounts anything.

    Regression: a12809f46. Any path was mounted and copied over the root
    filesystem.
    """
    fppinit.write("tmp/elsewhere.fppos", "not really an image\n")
    fppinit.write("settings", "")
    r = fppinit._run(["/opt/fpp/SD/upgradeOS-part1.sh", "/home/fpp/media/tmp/elsewhere.fppos"],
                     media_home=True)
    out = r.stdout + r.stderr
    assert "Refusing to upgrade from unexpected image path" in out, out[-3000:]
    assert r.returncode != 0, out[-3000:]
    assert not [c for c in fppinit.calls() if c.startswith("mount")], fppinit.calls()
    assert "BootActions" not in fppinit.media_file("settings")


def plugin_script(sb, script, *args):
    view = f"{MEDIA}/tmp/fppdir"
    if not sb.media_exists("tmp/fppdir"):
        fppdir_view(sb)
    r = sb._run(["unshare", "--net", f"{view}/scripts/{script}", *args])
    return r, r.stdout + r.stderr


def test_uninstall_plugin_removes_only_the_plugin_named(fppinit):
    """uninstall_plugin removes exactly the directory named: ".." and a
    path are refused, and "*" is a name, not every plugin.

    Regression: a12809f46. The name was unquoted in [ -d $1 ] and rm -rf
    $1, so "*" with one plugin installed matched it, and deleted it.
    """
    fppinit.write("plugins/fpp-keep/pluginInfo.json", {"name": "fpp-keep"})
    r, out = plugin_script(fppinit, "uninstall_plugin", "*")
    assert fppinit.media_exists("plugins/fpp-keep/pluginInfo.json"), \
        f"uninstalling '*' removed another plugin:\n{out[-3000:]}"
    for name in ("..", "fpp-keep/.."):
        r, out = plugin_script(fppinit, "uninstall_plugin", name)
        assert "Invalid plugin name" in out and r.returncode == 1, out[-3000:]
    # The control: a plugin named exactly is removed.
    r, out = plugin_script(fppinit, "uninstall_plugin", "fpp-keep")
    assert not fppinit.media_exists("plugins/fpp-keep"), out[-3000:]


EVIL = "#!/bin/sh\ntouch /fpp-test-media/pwned\nexit 1\n"


def test_install_plugin_takes_the_branch_as_one_value(fppinit):
    """install_plugin refuses a branch with a space in it, and hands git
    the one it accepts as a value: "main --upload-pack=..." does not become
    a git option that runs a command.

    Regression: a12809f46. The branch, URL and name went unquoted into
    git clone, so the branch split into options there.
    """
    origin = os.path.join(fppinit.media, "tmp", "plugin.git")
    git("init", "-q", "--bare", "-b", "main", origin)
    fppinit.write("tmp/evil.sh", EVIL)
    os.chmod(os.path.join(fppinit.media, "tmp", "evil.sh"), 0o755)
    url = f"file://{MEDIA}/tmp/plugin.git"
    r, out = plugin_script(fppinit, "install_plugin", "fpp-test", url,
                           f"main --upload-pack={MEDIA}/tmp/evil.sh", "")
    assert not fppinit.media_exists("pwned"), f"the branch became a git option:\n{out[-3000:]}"
    assert "Invalid branch" in out and r.returncode == 1, out[-3000:]
    r, out = plugin_script(fppinit, "install_plugin", "fpp test", url, "main", "")
    assert "Invalid plugin name" in out and r.returncode == 1, out[-3000:]
