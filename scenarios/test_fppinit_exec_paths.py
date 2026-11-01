"""fppinit runs the commands it needs by absolute path, not through whatever
PATH its caller has."""

from fppinit import fppinit  # noqa: F401 -- the fixture

# What the stubbed commands need to log a call: they print basename's output.
BASENAME = "#!/bin/sh\nexec /usr/bin/basename \"$@\"\n"


def test_boot_commands_do_not_depend_on_the_callers_path(fppinit):
    """With a PATH that holds nothing but basename (which the stubs use to
    name themselves in the call log), `fppinit start` still runs hostname:
    it reads the container's name with /usr/bin/hostname.

    Regression: 19b6d0032. The commands in fppinit were bare names, found
    only if PATH had their directory; started from a unit or a minimal
    environment, /usr/sbin tools (i2cset, iw, modprobe, nft) and the others
    were not found and their steps silently did nothing."""
    fppinit.root_file("/fppbin/basename", BASENAME)
    r = fppinit._run(["env", "PATH=/fppbin", "/opt/fpp/src/fppinit", "start"])
    calls = [c.split()[0] for c in fppinit.calls()]
    assert "hostname" in calls, f"hostname was not run; calls {calls}\n{r.stderr[-1500:]}"
