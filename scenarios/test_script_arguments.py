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


def test_uninstall_plugin_tells_the_plugin_whether_this_is_a_reinstall(fppinit):
    """A plugin's fpp_uninstall.sh sees FPP_PLUGIN_REINSTALL=1 when the
    uninstall is the first half of a Reinstall, and 0 on any other
    uninstall: one run by something that never set it, or with anything
    but 1 in it, which reaches the script as 0 rather than as it was.

    Feature: 4e019e14d. The wrapper names it on the $SUDO command line, as
    it does FPPDIR (the sandbox's sudo keeps the environment, so that part
    is not what this covers; the API test in plugin-history.spec.ts runs
    the real one).
    """
    view = f"{MEDIA}/tmp/fppdir"
    fppdir_view(fppinit)
    script = "#!/bin/sh\necho \"${FPP_PLUGIN_REINSTALL-unset}\" > /fpp-test-media/reinstall.txt\n"
    for given, expected in (("1", "1"), ("0", "0"), (None, "0"), ("yes", "0"), ("1 /bin/true", "0")):
        fppinit.write("reinstall.txt", "")
        fppinit.write("plugins/fpp-keep/scripts/fpp_uninstall.sh", script)
        os.chmod(os.path.join(fppinit.media, "plugins", "fpp-keep", "scripts", "fpp_uninstall.sh"), 0o755)
        env = [f"FPP_PLUGIN_REINSTALL={given}"] if given is not None else []
        r = fppinit._run(["env", *env, "unshare", "--net", f"{view}/scripts/uninstall_plugin", "fpp-keep"])
        out = r.stdout + r.stderr
        seen = fppinit.media_file("reinstall.txt").strip()
        assert seen == expected, \
            f"FPP_PLUGIN_REINSTALL={given!r}: the plugin saw {seen!r}\n{out[-3000:]}"
        assert not fppinit.media_exists("plugins/fpp-keep"), out[-3000:]


def test_plugin_scripts_run_on_macos_where_sudo_is_empty(fppinit):
    """A plugin's fpp_install.sh and fpp_uninstall.sh run, with FPPDIR
    set, on macOS, where scripts/common sets SUDO="".

    Regression: 69ca9e4c2. The wrappers ran "$SUDO FPPDIR=... script",
    which with an empty $SUDO ran "FPPDIR=..." as the command ("No such
    file or directory"): neither script ran, and the plugin's directory was
    removed all the same.
    """
    view = f"{MEDIA}/tmp/fppdir"
    fppdir_view(fppinit)
    fppinit.root_file("/etc/fpp/platform", "MacOS\n")
    seen = "#!/bin/sh\necho \"$1 ${FPPDIR:+set}\" > /fpp-test-media/$1.txt\n"
    for name in ("install", "uninstall"):
        fppinit.write(f"plugins/fpp-keep/scripts/fpp_{name}.sh", seen.replace("$1", name))
        os.chmod(os.path.join(fppinit.media, "plugins", "fpp-keep", "scripts", f"fpp_{name}.sh"), 0o755)
        fppinit.write(f"{name}.txt", "")
    r = fppinit._run(["unshare", "--net", f"{view}/scripts/install_plugin", "--run-install-script", "fpp-keep"])
    out = r.stdout + r.stderr
    assert fppinit.media_file("install.txt").strip() == "install set", \
        f"fpp_install.sh did not run, or ran without FPPDIR:\n{out[-3000:]}"
    r = fppinit._run(["unshare", "--net", f"{view}/scripts/uninstall_plugin", "fpp-keep"])
    out = r.stdout + r.stderr
    assert fppinit.media_file("uninstall.txt").strip() == "uninstall set", \
        f"fpp_uninstall.sh did not run, or ran without FPPDIR:\n{out[-3000:]}"
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


def test_git_pull_rebases_a_branch_with_a_stray_second_upstream(fppinit):
    """scripts/git_pull on a checkout set to pull by rebasing (as FPP's
    clone is), whose branch has picked up a second branch.<name>.merge
    line, with a new commit on its upstream: the upgrade moves the
    checkout onto that commit and rebuilds.

    Regression: f5a1df364. git_pull ran a plain "git pull", and a rebasing
    pull takes its target from FETCH_HEAD: with more than one "for-merge"
    line there -- from a stray merge line as here, or from the About
    page's background git_fetch writing FETCH_HEAD at the same moment, the
    intermittent case -- git refuses: "Cannot rebase onto multiple
    branches." It now fetches and rebases onto @{u}, which never reads
    FETCH_HEAD. (The lock that serializes git_fetch with it is not
    exercised.)

    The GitHub remote git_pull sets is sent to a local origin with a
    url.insteadOf in the checkout's config, and curl's reachability probe
    answers as GitHub does."""
    fpp = checkout_with_src(fppinit)
    git("config", "pull.rebase", "true", cwd=fpp)
    # its own commit (src/) is replayed onto the upstream
    git("config", "user.name", "fpp", cwd=fpp)
    git("config", "user.email", "fpp@localhost", cwd=fpp)
    git("config", "--add", "branch.v1.merge", "refs/heads/v2", cwd=fpp)
    git("config", f"url.{MEDIA}/tmp/origin.git.insteadOf", "https://github.com/FalconChristmas/fpp.git", cwd=fpp)
    work = os.path.join(fppinit.media, "tmp", "work")
    git("checkout", "-q", "v1", cwd=work)
    git("pull", "-q", "origin", "v1", cwd=work)
    git("commit", "-q", "--allow-empty", "-m", "new on v1", cwd=work)
    git("push", "-q", "origin", "HEAD:v1", cwd=work)
    new = head(work)
    fppinit.root_file("/usr/bin/curl", "#!/bin/sh\necho 'HTTP/2 200'\necho 'Content-Type: text/html; charset=utf-8'\n")
    r, out = run_script(fppinit, "git_pull")
    assert "Cannot rebase onto multiple branches" not in out, out[-3000:]
    on = subprocess.run(["git", "-c", "safe.directory=*", "-C", fpp, "merge-base", "--is-ancestor", new, "HEAD"])
    branch = subprocess.run(["git", "-c", "safe.directory=*", "-C", fpp, "symbolic-ref", "-q", "HEAD"],
                            capture_output=True, text=True).stdout.strip()
    assert on.returncode == 0 and branch == "refs/heads/v1", \
        f"the checkout did not move onto origin's v1 (HEAD {branch or 'detached'}):\n{out[-3000:]}"
    assert "make optimized" in made(fppinit) or "make all" in made(fppinit), \
        f"nothing was rebuilt: {made(fppinit)}\n{out[-3000:]}"
