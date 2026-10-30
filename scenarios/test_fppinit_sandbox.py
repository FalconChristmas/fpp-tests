"""The fppinit sandbox itself (fppinit.py): the stand-ins the scripts under
test meet, which a scenario's verdict rests on. A stand-in that does
nothing where the script relies on it makes a scenario pass for the wrong
reason.
"""

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture


def test_sudo_runs_its_command(fppinit):
    """sudo runs the command after its options, with any VAR=value
    assignments in its environment, and a command that isn't there fails.
    Without it, "$SUDO rm -rf ..." in a script failed to find sudo and
    removed nothing, and a scenario about what it removes passed."""
    r = fppinit._run(["sudo", "-E", "-u", "fpp", "FPP_TESTS_X=1", "sh", "-c",
                      f'echo "$FPP_TESTS_X" > {MEDIA}/tmp/ran'])
    assert r.returncode == 0, r.stdout + r.stderr
    assert fppinit.media_file("tmp/ran") == "1\n"
    r = fppinit._run(["sudo", "/fpp-tests-no-such-command"])
    assert r.returncode != 0, "sudo succeeded at running nothing"


def test_mount_is_recorded_and_says_it_did_nothing(fppinit):
    """mount is a stub: the call is recorded and it says on stderr that
    nothing was mounted, so a scenario can tell a mount that didn't happen
    from one that did; unstub("mount") gives the real one, whose mounts
    stay inside the sandbox."""
    fppinit.write("tmp/a", "a\n")
    fppinit.write("tmp/b", "b\n")
    bind = f"mount --bind {MEDIA}/tmp/a {MEDIA}/tmp/b; cat {MEDIA}/tmp/b"
    r = fppinit._run(["sh", "-c", bind])
    assert r.stdout == "b\n", r.stdout + r.stderr
    assert "mount is a stub" in r.stderr, r.stderr
    assert fppinit.calls() == [f"mount --bind {MEDIA}/tmp/a {MEDIA}/tmp/b"], fppinit.calls()

    fppinit.unstub("mount")
    r = fppinit._run(["sh", "-c", bind])
    assert r.stdout == "a\n", r.stdout + r.stderr
    assert fppinit.media_file("tmp/b") == "b\n", "the sandbox's mount reached the media directory itself"


def test_a_root_file_in_the_tree_stays_in_the_sandbox(fppinit):
    """root_file() over a file of the tree under test is seen inside the
    sandbox and leaves the tree itself alone. The tree is bound in, not
    overlaid, so a stand-in copied to /opt/fpp/src/fpp replaced the real
    CLI in the build every scenario (and every shard) shares, and the
    fpp-CLI scenarios run after it got empty output."""
    import os
    real = os.path.join(fppinit.tree, "src", "fpp")
    with open(real, "rb") as f:
        before = f.read()
    fppinit.root_file("/opt/fpp/src/fpp", "#!/bin/sh\necho stand-in\n")
    r = fppinit._run(["/opt/fpp/src/fpp"])
    assert r.stdout == "stand-in\n", r.stdout + r.stderr
    with open(real, "rb") as f:
        assert f.read() == before, "the stand-in was written into the tree under test"
