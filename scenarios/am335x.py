"""AM335x BeagleBone (BBB, PocketBeagle) PRU outputs under run-local.sh,
against the PRU subsystem fakepruss.c stands in for.

run-local.sh hides the PRUs from the test fppd (an empty
/sys/class/remoteproc and /lib/firmware, /dev/mem as /dev/null), and an
AM335x fppd has no FAKE_PRU mode of its own, so its PRU outputs would fail to
start. FakePruss fills that in: remoteproc state files for the two cores,
the image's sleep firmware links in /lib/firmware, and fakepruss.so, which
maps the PRU memories from files a scenario can read and acts on the
remoteproc starts and stops (see fakepruss.c).

The PRU programs are assembled at runtime by scripts fppd runs from
/opt/fpp/src (a hardcoded path), so when the tree under test is another one
its PRU sources are bound over /opt/fpp's, inside run-local.sh's private
mount namespace: the firmware built is the tree's own.

Cape string configs come from /opt/fpp/capes/<bbb|pb>/strings and panel
pinouts from /home/fpp/media/tmp/panels, both overlaid by run-local.sh.
"""

import json
import os
import shutil
import struct
import subprocess

import pytest

import shims

RPROC = "/sys/class/remoteproc"
FIRMWARE = "/lib/firmware"
PANELS = "/home/fpp/media/tmp/panels"


def _model():
    try:
        with open("/proc/device-tree/model", "rb") as f:
            return f.read().rstrip(b"\0").decode()
    except OSError:
        return ""


def _am335x():
    try:
        with open("/proc/device-tree/compatible", "rb") as f:
            return b"ti,am33xx" in f.read()
    except OSError:
        return False


def pocketbeagle():
    return _model().endswith("PocketBeagle")


def cape_dir():
    return "/opt/fpp/capes/" + ("pb" if pocketbeagle() else "bbb")


def needs_am335x(fppd):
    """Skip unless fppd runs on an AM335x BeagleBone under run-local.sh,
    with the tree built for it."""
    if not os.environ.get("FPP_TESTS_BEAGLE"):
        pytest.skip("needs a BeagleBone under run-local.sh")
    if not _am335x():
        pytest.skip("needs an AM335x BeagleBone (BBB, PocketBeagle)")
    if not os.path.exists(os.path.join(fppd.tree, "src", "libfpp-co-BBB48String.so")):
        pytest.skip("the tree is not built for a BeagleBone")
    try:
        hidden = os.stat("/dev/mem").st_rdev == os.stat("/dev/null").st_rdev
    except OSError:
        hidden = False
    if not hidden:
        pytest.skip("the PRUs are not hidden (run through run-local.sh)")


def _bind_tree_sources(tree):
    """Bind the tree's PRU program sources over /opt/fpp's (private mount
    namespace), so the runtime builds assemble the tree's firmware."""
    for rel in ("src/pru", "src/non-gpl/BBB48String"):
        src, dst = os.path.join(tree, rel), os.path.join("/opt/fpp", rel)
        if os.path.realpath(src) == os.path.realpath(dst) or not os.path.isdir(dst):
            continue
        if not os.path.samefile(src, dst):
            subprocess.run(["mount", "--bind", src, dst], check=True)


class FakePruss:
    """The two PRU cores and their memories, for one scenario's fppd.

    states:         each core's remoteproc state when fppd starts
                    ("running": the image's sleep firmware, as after boot;
                    "offline": stopped, as after an fppd that used it exited)
    undo:           how many clears of a core's enable bit its running
                    program undoes after each start (fakepruss.c)
    offline_fault:  "all": PRUSS RAM inaccessible while every core is
                    offline; "any": while any core is (fakepruss.c)
    noboot:         cores whose remoteproc start fails, leaving them offline
    """

    def __init__(self, fppd, states=("running", "running"), undo=0, offline_fault="", noboot=()):
        needs_am335x(fppd)
        self.fppd = fppd
        self.dir = os.path.join(fppd.media, "tmp", "fakepruss")
        os.makedirs(self.dir, exist_ok=True)
        for n in range(2):
            d = os.path.join(RPROC, f"remoteproc{n}")
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d)
            for name, value in (("state", states[n]), ("firmware", f"am335x-pru{n}-fw"),
                                ("name", f"4a33{4 + 4 * n}000.pru")):
                with open(os.path.join(d, name), "w") as f:
                    f.write(value + "\n")
            for f in os.listdir(FIRMWARE):
                if f.startswith(f"am335x-pru{n}-fw"):
                    os.unlink(os.path.join(FIRMWARE, f))
            with open(os.path.join(FIRMWARE, f"am335x-pru{n}-fw.sleep"), "wb") as f:
                f.write(self.sleep_firmware(n))
            os.symlink(f"am335x-pru{n}-fw.sleep", os.path.join(FIRMWARE, f"am335x-pru{n}-fw"))
        shutil.rmtree(PANELS, ignore_errors=True)
        _bind_tree_sources(fppd.tree)
        self.preload = [shims.build("fakepruss.c", libs=("-ldl", "-lpthread"))]
        self.env = {"FAKEPRUSS_DIR": self.dir}
        if undo:
            self.env["FAKEPRUSS_UNDO"] = str(undo)
        if offline_fault:
            self.env["FAKEPRUSS_OFFLINE_FAULT"] = offline_fault
        if noboot:
            self.env["FAKEPRUSS_NOBOOT"] = ",".join(str(n) for n in noboot)

    @staticmethod
    def sleep_firmware(n):
        return f"the image's sleep firmware for PRU{n}\n".encode()

    def start(self, timeout=90, **kw):
        """fppd.start() with the fake PRUs."""
        env = dict(self.env)
        env.update(kw.pop("extra_env", None) or {})
        return self.fppd.start(timeout=timeout, preload=self.preload + list(kw.pop("preload", ())),
                               extra_env=env, **kw)

    # ---- what happened -------------------------------------------------

    def events(self):
        try:
            with open(os.path.join(self.dir, "events")) as f:
                return f.read().splitlines()
        except OSError:
            return []

    def starts(self, core=None):
        """(core, program path, copy of what was loaded) for each start."""
        out = []
        for e in self.events():
            w = e.split()
            if w[0] == "start" and (core is None or int(w[1]) == core):
                out.append((int(w[1]), w[2], w[3]))
        return out

    def read(self, name, off, length):
        with open(os.path.join(self.dir, name), "rb") as f:
            f.seek(off)
            return f.read(length)

    def ctrl(self, core):
        """The core's CONTROL register."""
        return struct.unpack("<I", self.read("pruss", 0x22000 + core * 0x2000, 4))[0]

    def data_ram(self, core, off=0, length=8192):
        return self.read("pruss", core * 0x2000 + off, length)

    def shared_ram(self, off=0, length=12288):
        return self.read("pruss", 0x10000 + off, length)

    def ddr(self, off=0, length=0x400000):
        return self.read("ddr", off, length)

    def remoteproc_state(self, core):
        with open(os.path.join(RPROC, f"remoteproc{core}", "state")) as f:
            return f.read().strip()

    def firmware_link(self, core):
        return os.readlink(os.path.join(FIRMWARE, f"am335x-pru{core}-fw"))


def write_string_cape(name, cape):
    """Install a cape string config under `name`, the output's subType."""
    d = os.path.join(cape_dir(), "strings")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name + ".json")
    with open(path, "w") as f:
        json.dump(cape, f, indent=4)
    return path


def write_panel_pinout(name, pinout):
    """Install a panel pinout as the cape's own (media tmp/panels), which
    BBBMatrix reads before the ones under /opt/fpp/capes."""
    os.makedirs(PANELS, exist_ok=True)
    path = os.path.join(PANELS, name + ".json")
    with open(path, "w") as f:
        json.dump(pinout, f, indent=4)
    return path


def stock_panel_pinout(name="Octoscroller"):
    """A panel pinout the image ships (Octoscroller on a BBB, PocketScroller
    on a PocketBeagle), as JSON."""
    if pocketbeagle() and name == "Octoscroller":
        name = "PocketScroller"
    with open(os.path.join(cape_dir(), "panels", name + ".json")) as f:
        return json.load(f)
