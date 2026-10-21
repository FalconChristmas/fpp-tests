"""The device tools run-local.sh stands in for, and what the stand-ins saw.

Under run-local.sh, pinctrl and modprobe/rmmod/insmod/depmod are stubs that
log their calls (to /tmp/pinctrl.log and /tmp/kmod.log) and do nothing, so a
test fppd can neither re-mux the device's pads nor swap its kernel modules.
The real binaries stay reachable here, for a scenario that needs them for
itself -- reading or restoring the pads around a test, say. fppd gets the
real ones only with run-local.sh --host-pinctrl / --host-modules.
"""

import contextlib
import os
import subprocess

import pytest

PINCTRL_LOG = "/tmp/pinctrl.log"
KMOD_LOG = "/tmp/kmod.log"


def real(tool):
    """Path of the device's real `tool` (pinctrl, kmod, lsmod, modprobe, ...)
    under run-local.sh; skips the scenario where there is none."""
    d = os.environ.get("FPP_TESTS_HOST_TOOLS")
    path = os.path.join(d, tool) if d else None
    if not path or not os.path.exists(path):
        pytest.skip(f"no real {tool} here (run-local.sh keeps one on a device)")
    return path


def stubbed(tool):
    """True if fppd sees run-local.sh's stub for `tool` ("pinctrl" or
    "kmod") rather than the real one."""
    if not os.environ.get("FPP_TESTS_HOST_TOOLS"):
        return False
    flag = {"pinctrl": "FPP_TESTS_HOST_PINCTRL", "kmod": "FPP_TESTS_HOST_MODULES"}[tool]
    return not os.environ.get(flag)


class CallLog:
    """The calls a stub logged from now on."""

    def __init__(self, path):
        self.path = path
        self.start = os.path.getsize(path) if os.path.exists(path) else 0

    def calls(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path) as f:
            f.seek(self.start)
            return [l.rstrip("\n") for l in f if l.strip()]


def pinctrl_calls():
    """A CallLog of the pinctrl stub, from now on."""
    return CallLog(PINCTRL_LOG)


def kmod_calls():
    """A CallLog of the module-command stub, from now on."""
    return CallLog(KMOD_LOG)


def pad_states(gpios):
    """Each Raspberry Pi pad's function, drive and pull as the real pinctrl
    reports them ("ip pd", "op dh pn"), by GPIO number; None where pinctrl
    can't say. The level an input reads is left out: a floating input's
    drifts."""
    out = {}
    for g in gpios:
        r = subprocess.run([real("pinctrl"), "get", str(g)], capture_output=True, text=True)
        out[g] = (r.stdout.split("//")[0].split(":", 1)[-1].split("|")[0].strip()
                  if r.returncode == 0 else None)
    return out


@contextlib.contextmanager
def pads_kept(gpios):
    """Put these pads back as they were, after the block. A gpiod request
    moves a pad to the gpio function, its release leaves it there (an
    output still driving), and fppd's own restore goes to run-local.sh's
    pinctrl stub. Wrap fppd's whole life in it: it must restore after fppd
    has stopped."""
    before = pad_states(gpios)
    try:
        yield
    finally:
        for g, was in before.items():
            if was and pad_states([g])[g] != was:
                # "no    pd" or "op dh pn": function, then drive, then pull
                subprocess.run([real("pinctrl"), "set", str(g), *[w for w in was.split() if w != "--"]])
    assert pad_states(gpios) == before, (before, pad_states(gpios))
