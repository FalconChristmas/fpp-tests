"""Whether scripts/git_pull updates the checkout's submodules, which depends
on the platform. Runs in the fppinit sandbox like test_git_update_scripts.py,
against a checkout whose commit carries a submodule (a clone of the local
origin), with no network."""

import os

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_git_update_scripts import REACHABLE, pull_checkout, run_script
from test_system_scripts import git

SUB = "external/fpp-tests-sub"


def checkout_with_submodule(sb):
    """pull_checkout(), with the new commit on origin's v1 adding a submodule
    (a clone of the local origin itself), so the pull brings it in."""
    fpp, origin_head = pull_checkout(sb)
    work = os.path.join(sb.media, "tmp", "work")
    with open(os.path.join(work, ".gitmodules"), "w") as f:
        f.write(f'[submodule "{SUB}"]\n\tpath = {SUB}\n\turl = {MEDIA}/tmp/origin.git\n')
    git("add", ".gitmodules", cwd=work)
    git("update-index", "--add", "--cacheinfo", f"160000,{origin_head},{SUB}", cwd=work)
    git("commit", "-q", "-m", "a submodule", cwd=work)
    git("push", "-q", "origin", "HEAD:v1", cwd=work)
    # git refuses a local-path submodule clone unless the file protocol is
    # allowed, and the checkout's own commit is rebased onto the pull
    sb.root_file("/etc/gitconfig", "[protocol \"file\"]\n\tallow = always\n"
                 "[user]\n\tname = fpp-tests\n\temail = fpp-tests@example.com\n")
    sb.root_file("/usr/bin/curl", REACHABLE)
    return fpp


def test_submodules_are_updated_on_a_raspberry_pi(fppinit):
    """git_pull on a Raspberry Pi initialises the checkout's submodules.
    (The control for the test below.)"""
    fpp = checkout_with_submodule(fppinit)
    fppinit.root_file("/etc/fpp/platform", "Raspberry Pi\n")
    r, out = run_script(fppinit, "git_pull")
    assert os.path.isdir(os.path.join(fpp, SUB, ".git")) or os.path.isfile(os.path.join(fpp, SUB, ".git")), \
        f"the Pi did not get the submodule:\n{out[-3000:]}"


def test_submodules_are_left_alone_off_a_raspberry_pi(fppinit):
    """git_pull on any other platform (a BeagleBone, whose build has no
    submodule) does not sync or update them.

    Regression: 22e3a758e. The submodule sync/update ran on every platform,
    fetching sources a non-Pi build never uses (slow, and a failure of it
    held up the update)."""
    fpp = checkout_with_submodule(fppinit)
    fppinit.root_file("/etc/fpp/platform", "BeagleBone Black\n")
    r, out = run_script(fppinit, "git_pull")
    assert "Upgrading config" in out or r.returncode == 0, f"git_pull did not get as far as the pull:\n{out[-3000:]}"
    assert not os.path.exists(os.path.join(fpp, SUB, ".git")), f"the submodule was initialised off a Pi:\n{out[-3000:]}"
