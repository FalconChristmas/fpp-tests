"""String outputs that use both PRU cores of an AM335x BeagleBone, against
the fake PRU subsystem of am335x.py and fakepruss.c: BBShiftString with
strings on PRU0 and PRU1, and BBB48String with its GPIO0 program on the
second core. A scenario reads back which program each core was started
with and what was left in each core's data RAM.

Device only: run with run-local.sh on a BeagleBone Black (the BBShiftString
scenarios use its P8/P9 PRU pins) or a PocketBeagle. The GPIO lines are the
real ones, so stop the device's own fppd first. Skipped elsewhere.
"""

import struct
import time

import pytest

from am335x import FakePruss, pocketbeagle, write_string_cape
from bbcape import pixel_output, strings_config
from test_am335x_pru import string_pins

PINCFG_OFFSET = 0x1FE8   # BBShiftString.cpp: clock/latch bits, 0xA5 in the top byte
TIMING_MAGIC = 16 + 12   # publishTiming(): 0xA5A5A5A5 written last


def needs_bbb():
    if pocketbeagle():
        pytest.skip("BBShiftString's PRU0 pins are on the BeagleBone Black's P8/P9")


def two_pru_shift_strings(fppd):
    """A shift cape with eight strings on each PRU's first data pin, and a
    string on each PRU (ports 1 and 9; the ones between have no pixels)."""
    outs = [{"pru": p, "pin": 0, "index": i} for p in (1, 0) for i in range(8)]
    write_string_cape("TestTwoPru", {"driver": "BBShiftString", "outputs": outs})
    ports = [pixel_output(n, 10 if n in (0, 8) else 0, 0 if n == 0 else 30) for n in range(9)]
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestTwoPru", ports))


def program(core):
    """The program fppd loads for PRU `core`'s strings (from /opt/fpp/src,
    whatever tree it was built from)."""
    with open(f"/opt/fpp/src/non-gpl/BBShiftString/BBShiftString_pru{core}.out", "rb") as f:
        return f.read()


def loaded(start):
    """What a core was started with, from the fake's copy of it."""
    with open(start[2], "rb") as f:
        return f.read()


def section_size(elf, name):
    """Size of the named section of a 32-bit ELF image (None if it has
    none)."""
    shoff, = struct.unpack_from("<I", elf, 0x20)
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", elf, 0x2E)
    strtab_off, = struct.unpack_from("<I", elf, shoff + shstrndx * shentsize + 16)
    for i in range(shnum):
        sh = shoff + i * shentsize
        sh_name, = struct.unpack_from("<I", elf, sh)
        end = elf.index(b"\0", strtab_off + sh_name)
        if elf[strtab_off + sh_name:end] == name.encode():
            return struct.unpack_from("<I", elf, sh + 20)[0]
    return None


def word(pru, core, off):
    return struct.unpack("<I", pru.data_ram(core, off, 4))[0]


def test_each_pru_runs_its_own_shift_string_program(fppd):
    """With strings on both PRUs, PRU1 is started with
    BBShiftString_pru1.out and PRU0 with BBShiftString_pru0.out, and both
    stay running.

    Regression: 3e41649cf. The PRU0 branch called m_pru1.pru->run() with
    the PRU0 program: PRU1 was restarted with the wrong program and PRU0
    never started (the K128's second half of strings stayed dark).
    """
    needs_bbb()
    pru = FakePruss(fppd)
    two_pru_shift_strings(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    pru.start()
    fppd.wait_for(lambda: pru.starts(0) and pru.starts(1), timeout=30,
                  what=f"both cores to start ({pru.events()})")
    time.sleep(2)
    for core in (0, 1):
        starts = pru.starts(core)
        assert len(starts) == 1, f"PRU{core} started {len(starts)} times: {pru.events()}"
        assert loaded(starts[0]) == program(core), f"PRU{core} was not started with BBShiftString_pru{core}.out"
    assert pru.remoteproc_state(0) == pru.remoteproc_state(1) == "running"
    assert "Crash handler called" not in fppd.log(), fppd.tail()


def test_starting_pru0_leaves_pru1s_data_ram_alone(fppd):
    """Starting PRU0's strings leaves what fppd had already handed PRU1 in
    PRU1's data RAM: its pin config and its bit timing, both marked as
    written (the firmware waits for those marks).

    Regression: 287f65498. Each core's BBBPru mapped the other core's data
    RAM, and run() clears it with its own: starting PRU0 wiped the timing,
    pin config and command table PRU1 had been given a moment before.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    two_pru_shift_strings(fppd)
    pru.start()
    fppd.wait_for(lambda: pru.starts(0) and pru.starts(1), timeout=30,
                  what=f"both cores to start ({pru.events()})")
    time.sleep(2)
    # the control: PRU0's own block was written after its start
    assert word(pru, 0, TIMING_MAGIC) == 0xA5A5A5A5, hex(word(pru, 0, TIMING_MAGIC))
    assert word(pru, 1, TIMING_MAGIC) == 0xA5A5A5A5, \
        f"PRU1's timing block after PRU0 started: {word(pru, 1, TIMING_MAGIC):#010x}"
    assert word(pru, 1, PINCFG_OFFSET) >> 24 == 0xA5, \
        f"PRU1's pin config after PRU0 started: {word(pru, 1, PINCFG_OFFSET):#010x}"


def test_the_gpio0_program_is_built_with_its_resource_table(fppd):
    """A BBB48String output with strings on GPIO0 pins runs a second
    program on PRU0, and that program carries a resource table (a
    non-empty .resource_table section) for the remoteproc loader, as the
    PRU1 program does.

    Regression: 73a4a66ae (its compileWS2811x_gpio0.sh half). The GPIO0
    program was preprocessed without -DAM33XX, the condition
    ResourceTable.asm is under, so its .resource_table section came out
    empty -- the trouble starting the second PRU the commit was after. A
    check of the program the core was handed: the fake runs no PRU code.
    (The other half, writing the control block after run(), has no effect
    since run() stopped clearing the data RAM for this output.)
    """
    pru = FakePruss(fppd)
    pins, gpio0 = string_pins()
    write_string_cape("TestGpio0Rsc", {"outputs": [{"pin": pins[0]}, {"pin": gpio0[0]}]})
    cfg = strings_config("BBB48String", "TestGpio0Rsc", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)])
    cfg["channelOutputs"][0]["serialInUse"] = False  # the GPIO0 strings get PRU0 to themselves
    fppd.write("config/co-bbbStrings.json", cfg)
    pru.start()
    fppd.wait_for(lambda: pru.starts(0) and pru.starts(1), timeout=60,
                  what=f"both cores to start ({pru.events()})")
    progs = {}
    for core in (0, 1):
        with open(pru.starts(core)[-1][2], "rb") as f:
            progs[core] = f.read()
    sizes = {core: section_size(progs[core], ".resource_table") for core in (0, 1)}
    # the control: the PRU1 program has one
    assert sizes[1], f"the PRU1 program has no resource table: {sizes}"
    assert sizes[0], f"the GPIO0 program on PRU0 has no resource table: {sizes}"
