"""The real PRUs of an AM62x BeagleBone, read from the test's side, for
scenarios run with run-local.sh --host-pru (the device's own fppd stopped).

`Pruss` maps the PRU subsystem through /dev/mem: the cores' data RAMs, the
shared RAM the SMEM rings live in, and each core's control and debug
registers, so a scenario can check what a PRU program was handed and what
it did -- not just what fppd logged. Reads and writes are single aligned
32-bit accesses: the PRU memories are uncached, and a wider or unaligned
access faults on aarch64.

fppd loads its PRU programs from /opt/fpp/src whatever tree it was built
from; the `real_pru` fixture copies the tree's images over them in
run-local.sh's /opt/fpp overlay, so a tree with reverted firmware runs it.
"""

import ctypes
import glob
import mmap
import os
import shutil
import struct

import pytest

PRUSS_BASE = 0x30040000
PRUSS_SIZE = 0x80000
DRAM = (0x00000, 0x02000)  # each core's 8KB data RAM, within the window
SHARED = 0x10000           # 32KB shared RAM
SHARED_PRU_ADDR = 0x10000  # where the PRUs see it (SMEM_RING_SMEM_PRU_ADDR)
CTRL = (0x22000, 0x24000)  # core control blocks
DEBUG = 0x400              # debug registers (r0-r31 of a halted core), past CTRL

CTRL_ENABLE = 0x2
CTRL_RUNSTATE = 0x8000

# ring statistics and handshake words in the owning core's data RAM (SMEMRing.hp)
RING_STATS = 0x1FE0
RING_FRAMES = 0x1FE4
RING_RESYNC = 0x1FEC
RING_CONFIG = 0x1FF0

REMOTEPROC = "/sys/class/remoteproc"


@pytest.fixture
def real_pru():
    """For a scenario whose fppd drives the real PRUs of an AM62x board:
    skips unless run-local.sh --host-pru gives it them with nothing else
    running them, and makes the tree's own PRU programs the ones fppd loads
    (use_tree_firmware). Ask for it ahead of the fppd fixture: it is torn
    down after it, and stops any core a killed fppd left running.
    """
    if not os.environ.get("FPP_TESTS_BEAGLE") or not os.environ.get("FPP_TESTS_HOST_PRU"):
        pytest.skip("needs a BeagleBone under run-local.sh --host-pru")
    try:
        with open("/proc/device-tree/compatible", "rb") as f:
            if b"am62" not in f.read():
                pytest.skip("AM62x only")
    except OSError:
        pytest.skip("no device tree")
    tree = os.environ["FPP_TREE"]
    if not os.path.exists(os.path.join(tree, "src", "libfpp-co-BBShiftString.so")):
        pytest.skip("the tree is not built for a BeagleBone")
    for core in (0, 1):
        if core_state(core) == "running":
            pytest.skip(f"PRU {core} is running: stop the device's own fppd first")
    use_tree_firmware(tree)
    yield
    for core in (0, 1):
        if core_state(core) == "running":
            with open(core_state_file(core), "w") as f:
                f.write("stop")


def core_state_file(core):
    for r in glob.glob(os.path.join(REMOTEPROC, "remoteproc*")):
        try:
            with open(os.path.join(r, "name")) as f:
                if f.read().strip() == ("30074000.pru", "30078000.pru")[core]:
                    return os.path.join(r, "state")
        except OSError:
            pass
    return None


def core_state(core):
    """remoteproc's state of PRU `core`: "offline", "running", ..."""
    path = core_state_file(core)
    if not path:
        return None
    with open(path) as f:
        return f.read().strip()


class Pruss:
    def __init__(self):
        fd = os.open("/dev/mem", os.O_RDWR | os.O_SYNC)
        try:
            self.mm = mmap.mmap(fd, PRUSS_SIZE, mmap.MAP_SHARED,
                                mmap.PROT_READ | mmap.PROT_WRITE, offset=PRUSS_BASE)
        finally:
            os.close(fd)

    def close(self):
        self.mm.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def read32(self, off):
        return ctypes.c_uint32.from_buffer(self.mm, off).value

    def write32(self, off, value):
        ctypes.c_uint32.from_buffer(self.mm, off).value = value & 0xFFFFFFFF

    def read(self, off, n):
        """n bytes (a multiple of 4) from `off`, one word at a time."""
        return b"".join(struct.pack("<I", self.read32(off + i)) for i in range(0, n, 4))

    def dram(self, core, off):
        return self.read32(DRAM[core] + off)

    def shared(self, off):
        return self.read32(SHARED + off)

    def control(self, core):
        return self.read32(CTRL[core])

    def pc(self, core):
        """The core's program counter (in instructions) from its status
        register."""
        return self.read32(CTRL[core] + 4) & 0xFFFF

    def halted(self, core):
        return not self.control(core) & CTRL_RUNSTATE

    def halt(self, core):
        """Halt a running core: clear its enable bit until it stays clear
        and the core has stopped. The FPP programs read-modify-write this
        register to restart their cycle counter, which can undo a single
        write (see haltCore() in BBBPruUtils.cpp)."""
        for _ in range(10000):
            v = self.control(core)
            if not v & CTRL_ENABLE and not v & CTRL_RUNSTATE:
                return True
            self.write32(CTRL[core], v & ~CTRL_ENABLE)
        return False

    def resume(self, core):
        self.write32(CTRL[core], self.control(core) | CTRL_ENABLE)

    def set_register(self, core, n, value):
        """Set r`n` of a halted core through its debug registers."""
        self.write32(CTRL[core] + DEBUG + 4 * n, value)

    def register(self, core, n):
        """r`n` of a halted core, from its debug registers."""
        return self.read32(CTRL[core] + DEBUG + 4 * n)


def use_tree_firmware(tree):
    """Make the PRU program images built in `tree` the ones fppd loads: it
    runs them from /opt/fpp/src, which run-local.sh overlays, whatever tree
    it was built from."""
    src = os.path.realpath(os.path.join(tree, "src"))
    dst = "/opt/fpp/src"
    if src == os.path.realpath(dst):
        return
    for image in glob.glob(os.path.join(src, "non-gpl", "*", "*.out")) + \
            glob.glob(os.path.join(src, "pru", "*.out")):
        rel = os.path.relpath(image, src)
        os.makedirs(os.path.dirname(os.path.join(dst, rel)), exist_ok=True)
        shutil.copyfile(image, os.path.join(dst, rel))


def halt_instructions(image):
    """Instruction indexes of every HALT in a PRU program image (an ELF
    file): where a core that stopped itself sits."""
    with open(image, "rb") as f:
        elf = f.read()
    shoff, = struct.unpack_from("<I", elf, 0x20)
    shentsize, shnum = struct.unpack_from("<HH", elf, 0x2E)
    found = []
    for i in range(shnum):
        sh = shoff + i * shentsize
        sh_type, sh_flags, sh_addr, sh_offset, sh_size = struct.unpack_from("<IIIII", elf, sh + 4)
        if sh_type == 1 and sh_flags & 0x4:  # PROGBITS, executable
            for n in range(0, sh_size, 4):
                word, = struct.unpack_from("<I", elf, sh_offset + n)
                if word == 0x2A000000:  # HALT
                    found.append((sh_addr + n) // 4)
    return found
