"""FPP's git update path (scripts/git_pull, git_branch, git_fetch) on the
outcomes the About and Developer pages depend on: a pull that fails, an
unreachable update source, a branch whose Apache site config differs, and
a branch from the separate new-features repository. Each runs in the
fppinit sandbox (fppinit.py) against an FPP checkout made in the media
directory with a local origin (test_script_arguments.py's), never /opt/fpp,
and with no network.
"""

import os
import subprocess

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_script_arguments import CHECKOUT, checkout_with_src, head, made, run_script
from test_system_scripts import git

GITHUB = "https://github.com/FalconChristmas/fpp.git"
# curl's reachability probe answering as GitHub does
REACHABLE = "#!/bin/sh\necho 'HTTP/2 200'\necho 'Content-Type: text/html; charset=utf-8'\n"
LIVE_SITE = "/etc/apache2/sites-available/000-default.conf"


def in_sandbox_git(sb, *args):
    """git in the checkout as the sandbox sees it, where its remotes'
    paths (under the media directory's sandbox path) resolve."""
    r = sb._run(["git", "-c", "safe.directory=*", "-C", CHECKOUT, *args])
    assert r.returncode == 0, r.stdout + r.stderr


def gitout(fpp, *args):
    return subprocess.run(["git", "-c", "safe.directory=*", "-C", fpp, *args],
                          capture_output=True, text=True).stdout.strip()


def pull_checkout(sb):
    """checkout_with_src() set up for git_pull: GitHub's URL sent to the
    local origin, which has a new commit on v1 the checkout lacks.
    Returns (checkout, the new commit)."""
    fpp = checkout_with_src(sb)
    git("config", f"url.{MEDIA}/tmp/origin.git.insteadOf", GITHUB, cwd=fpp)
    work = os.path.join(sb.media, "tmp", "work")
    git("checkout", "-q", "v1", cwd=work)
    git("pull", "-q", "origin", "v1", cwd=work)
    with open(os.path.join(work, "README"), "w") as f:
        f.write("new upstream\n")
    git("add", "README", cwd=work)
    git("commit", "-q", "-m", "new on v1", cwd=work)
    git("push", "-q", "origin", "HEAD:v1", cwd=work)
    return fpp, head(work)


def test_a_failed_pull_stops_the_update(fppinit):
    """git_pull on a checkout whose pull can't be applied (a local edit to a
    tracked file, as a user's hand fix leaves) exits non-zero and goes no
    further: the config upgrades and the rebuild are not run, and the
    checkout stays where it was. manualUpdate.php reports the update failed
    on that status (manual-update-failed-pull.spec.ts).

    Regression: 5c0b83a10. The script ran on past the failed pull, rebuilt
    the old code and exited 0, so the update was reported complete."""
    fpp, new = pull_checkout(fppinit)
    before = head(fpp)
    with open(os.path.join(fpp, "scripts", "common"), "a") as f:
        f.write("# a local edit\n")
    fppinit.root_file("/usr/bin/curl", REACHABLE)
    r, out = run_script(fppinit, "git_pull")
    assert head(fpp) == before, f"the checkout moved:\n{out[-3000:]}"
    # The control: the pull was tried and failed for the local edit.
    assert "unstaged changes" in out or "local changes" in out, out[-3000:]
    assert made(fppinit) == [], f"the update went on to rebuild after the failed pull: {made(fppinit)}\n{out[-3000:]}"
    assert "Upgrading config" not in out, f"the config upgrades ran after the failed pull:\n{out[-3000:]}"
    assert r.returncode != 0, f"git_pull exited 0 after a failed pull:\n{out[-3000:]}"


def test_an_unreachable_update_source_points_to_the_health_check(fppinit):
    """git_pull with the update source unreachable says so and points the
    user to Help -> System Health Check to check the player's internet
    access, and exits non-zero.

    Regression: b7732f1ea (the message only said the source could not be
    reached)."""
    pull_checkout(fppinit)
    fppinit.root_file("/usr/bin/curl", "#!/bin/sh\nexit 6\n")
    r, out = run_script(fppinit, "git_pull")
    assert "unable to pull git updates" in out, out[-3000:]
    assert "Help->System Health Check" in out, out[-3000:]
    assert r.returncode != 0, out[-3000:]


def branch_with_site(sb, site):
    """checkout_with_src(), with origin's v2 carrying etc/apache2.site."""
    fpp = checkout_with_src(sb)
    work = os.path.join(sb.media, "tmp", "work")
    git("checkout", "-q", "v2", cwd=work)
    os.makedirs(os.path.join(work, "etc"), exist_ok=True)
    with open(os.path.join(work, "etc", "apache2.site"), "w") as f:
        f.write(site)
    git("add", "-A", cwd=work)
    git("commit", "-q", "-m", "v2 site", cwd=work)
    git("push", "-q", "origin", "HEAD:v2", cwd=work)
    # as the background git_fetch has by the time a branch is picked
    in_sandbox_git(sb, "fetch", "-q", "origin")
    return fpp


V2_SITE = "# fpp-tests: v2's site config\n<VirtualHost *:80>\n</VirtualHost>\n"


def test_a_branch_switch_installs_the_branchs_apache_site(fppinit):
    """git_branch to a branch whose etc/apache2.site differs from the live
    site config copies the branch's over it.

    Regression: 151f01b58. A switch left the old branch's Apache config
    live, so a branch that needed a different one (a new proxy, header or
    module) ran against the wrong one until the next config upgrade. (The
    branch's config being one Apache accepts is
    manual-update-apache-site.spec.ts's check, for the tree's own.)"""
    fpp = branch_with_site(fppinit, V2_SITE)
    fppinit.root_file(LIVE_SITE, "# fpp-tests: v1's site config\n")
    r, out = run_script(fppinit, "git_branch", "v2")
    assert gitout(fpp, "rev-parse", "--abbrev-ref", "HEAD") == "v2", f"not switched:\n{out[-3000:]}"
    assert fppinit.written(LIVE_SITE) == V2_SITE, \
        f"the live site config is not the branch's: {fppinit.written(LIVE_SITE)!r}\n{out[-3000:]}"
    assert "Updating apache2 site configuration" in out, out[-3000:]


def test_a_branch_switch_leaves_a_current_apache_site_alone(fppinit):
    """git_branch to a branch whose etc/apache2.site is the live one already
    doesn't rewrite it. (The control for the test above.)"""
    fpp = branch_with_site(fppinit, V2_SITE)
    fppinit.root_file(LIVE_SITE, V2_SITE)
    r, out = run_script(fppinit, "git_branch", "v2")
    assert gitout(fpp, "rev-parse", "--abbrev-ref", "HEAD") == "v2", f"not switched:\n{out[-3000:]}"
    assert "Updating apache2 site configuration" not in out, out[-3000:]
    assert fppinit.written(LIVE_SITE) == V2_SITE


NEWFEATURES = "https://github.com/FalconChristmas/fpp-new-feature-testing.git"


def new_features_checkout(sb):
    """checkout_with_src(), and a new-features repository with a branch
    origin hasn't got, which the GitHub URL of the newfeatures remote is
    sent to. Returns (checkout, the branch's commit)."""
    fpp = checkout_with_src(sb)
    tmp = os.path.join(sb.media, "tmp")
    nf, nfwork = os.path.join(tmp, "newfeatures.git"), os.path.join(tmp, "nfwork")
    git("init", "-q", "--bare", nf)
    git("clone", "-q", os.path.join(tmp, "origin.git"), nfwork)
    git("checkout", "-q", "v1", cwd=nfwork)
    git("commit", "-q", "--allow-empty", "-m", "a new feature", cwd=nfwork)
    git("push", "-q", nf, "HEAD:refs/heads/nf-feature", cwd=nfwork)
    git("config", f"url.{MEDIA}/tmp/newfeatures.git.insteadOf", NEWFEATURES, cwd=fpp)
    return fpp, head(nfwork)


def test_git_fetch_adds_the_new_features_remote(fppinit):
    """The Developer page's background git_fetch adds the newfeatures remote
    (FPP's separate new-feature testing repository) to a checkout that
    hasn't got it.

    Feature: 86bdee6fa."""
    fpp, _ = new_features_checkout(fppinit)
    assert gitout(fpp, "config", "remote.newfeatures.url") == ""
    r, out = run_script(fppinit, "git_fetch", "--force")
    assert gitout(fpp, "config", "remote.newfeatures.url") == NEWFEATURES, \
        f"git_fetch did not add the newfeatures remote: {gitout(fpp, 'remote', '-v')}\n{out[-3000:]}"


def test_a_branch_from_the_new_features_repository(fppinit):
    """git_branch <branch> newfeatures switches to that branch of the
    newfeatures remote, a repository separate from origin, tracking it.

    Feature: 86bdee6fa. git_branch only took a branch, always of origin:
    a branch only the new-features repository has was "Invalid Branch
    Name"."""
    fpp, feature = new_features_checkout(fppinit)
    # As the Developer settings page fetches it when it lists the branches
    # (git fetch -p --all); git_branch leaves origin's and newfeatures' to it.
    git("remote", "add", "newfeatures", NEWFEATURES, cwd=fpp)
    in_sandbox_git(fppinit, "fetch", "-q", "newfeatures")
    r, out = run_script(fppinit, "git_branch", "nf-feature", "newfeatures")
    assert "Invalid Branch Name" not in out, out[-3000:]
    assert gitout(fpp, "rev-parse", "--abbrev-ref", "HEAD") == "nf-feature", out[-3000:]
    assert head(fpp) == feature, f"not on the new-features branch's commit:\n{out[-3000:]}"
    assert gitout(fpp, "rev-parse", "--abbrev-ref", "nf-feature@{u}") == "newfeatures/nf-feature"
