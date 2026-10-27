"""Names fppinit puts on the command lines it runs as root, in the fppinit
sandbox (fppinit.py): each reaches the command as one argument, whatever
characters it has.
"""

from fppinit import fppinit  # noqa: F401 -- the fixture


def assert_clean(r):
    out = r.stdout + r.stderr
    assert "terminate called" not in out and "AddressSanitizer" not in out, out[-3000:]
    assert r.returncode == 0, f"fppinit exited {r.returncode}:\n{out[-3000:]}"


def test_an_interface_named_by_its_config_file_is_one_shell_word(fppinit):
    """A config/interface.<name> file with masquerading on (IPFORWARDING 2)
    whose <name> has a ";" in it: setupNetwork's nft rule gets the name as
    one word, and the command after the ";" is never run.

    Regression: 583eac3b5. The interface name -- the config file's name,
    which nothing checks -- was pasted unquoted into "nft add rule nat
    postrouting oif <name> masquerade" and run through the shell as root.
    The name here runs systemctl, one of the sandbox's recording stubs."""
    name = "fpptests;systemctl fpp-tests-injected;"
    fppinit.write(f"config/interface.{name}",
                  f'INTERFACE="{name}"\nPROTO="static"\nADDRESS="192.168.77.1"\n'
                  'NETMASK="255.255.255.0"\nIPFORWARDING="2"\n')
    r = fppinit.run("setupNetwork")
    assert_clean(r)
    calls = fppinit.calls()
    # The control: the name reached setupNetwork's interface handling (its
    # networkd file was written).
    assert fppinit.written(f"/etc/systemd/network/10-{name}.network") is not None, calls
    assert not [c for c in calls if "fpp-tests-injected" in c], calls
