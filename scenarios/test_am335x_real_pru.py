"""The real PRUs of an AM335x BeagleBone under a BBB48String output, read
from the test's side with pru.Pruss (the AM335x counterpart of
test_am62x_bbb48string.py's harness).

Device only: run with run-local.sh --host-pru on a BeagleBone Black or a
PocketBeagle, with the device's own fppd stopped. The GPIO lines and the PRU
cores are the real ones.
"""

import mmap
import os
import time

import pytest

from am335x import write_string_cape
from bbcape import pixel_output, strings_config
from pru import Pruss, core_state, real_pru_am335x  # noqa: F401 (a fixture)
from test_am335x_pru import string_pins


def start_strings(fppd):
    pins, _ = string_pins()
    write_string_cape("TestReal", {"outputs": [{"pin": p} for p in pins[:2]]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestReal", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)]))
    fppd.start()
    fppd.wait_for(lambda: core_state(1) == "running", timeout=60, what="PRU1 to be running the strings program")


def test_a_bbb48string_output_runs_a_real_pru_and_its_memory_can_be_read(real_pru_am335x, fppd):
    """The harness itself: a two-port BBB48String output starts PRU1 on the
    real AM335x PRUSS, the core is enabled and not halted, and its data RAM
    and the shared RAM read and write as words from the test.
    """
    start_strings(fppd)
    with Pruss() as pruss:
        assert pruss.control(1) & 0x2, f"PRU1's control word {pruss.control(1):#x}: not enabled"
        assert not pruss.halted(1), "PRU1 is halted"
        pc1, pc2 = pruss.pc(1), None
        time.sleep(0.2)
        pc2 = pruss.pc(1)
        # a word of the core's data RAM the program does not use, and one of
        # the shared RAM, take a value and give it back
        for read, write, off in ((lambda o: pruss.dram(1, o), lambda o, v: pruss.write32(0x2000 + o, v), 0x1000),
                                 (pruss.shared, lambda o, v: pruss.write32(0x10000 + o, v), 0x2F00)):
            write(off, 0xA5A55A5A)
            assert read(off) == 0xA5A55A5A, f"offset {off:#x} of the memory did not hold what was written"
            write(off, 0)



ADDRESS_DMA, COMMAND, RESPONSE = 0, 4, 8  # BBB48StringData, at the start of PRU1's data RAM


def ddr_frame(address, size=4096):
    """`size` bytes of the DDR the PRU reads its frame from, at physical
    `address`, as words."""
    page = address & ~0xFFF
    fd = os.open("/dev/mem", os.O_RDONLY | os.O_SYNC)
    try:
        mm = mmap.mmap(fd, size + (address - page), mmap.MAP_SHARED, mmap.PROT_READ, offset=page)
    finally:
        os.close(fd)
    try:
        return bytes(mm[address - page:address - page + size])
    finally:
        mm.close()


def test_the_frame_in_the_prus_ddr_follows_the_pixels_fppd_is_sending(real_pru_am335x, fppd):
    """With a BBB48String output running, PRU1 is taking frames (it sets the
    response word as it takes each) from the DDR address fppd handed it, and
    what is there is the pixel data bit-planed for the pins: a black frame
    is the same every time and a white one is not the same as it.

    The harness's end-to-end check, with its control (black twice); it holds
    for any change that stops the pixel data reaching the PRU's buffer.
    """
    start_strings(fppd)
    fppd.command("Test Start", "1000", "RGB Single Color", "*", "#000000")
    with Pruss() as pruss:
        fppd.wait_for(lambda: pruss.dram(1, RESPONSE) == 1 and not pruss.halted(1), timeout=30,
                      what="PRU1 to take a frame")
        address = pruss.dram(1, ADDRESS_DMA)
        assert 0x80000000 <= address < 0xA0000000, f"PRU1 was handed {address:#x}, not a DDR address"
        time.sleep(0.5)
        black_a = ddr_frame(address)
        time.sleep(0.5)
        black_b = ddr_frame(address)
        assert black_a == black_b, "the control: a black frame changed between reads"
        fppd.command("Test Start", "1000", "RGB Single Color", "*", "#FFFFFF")
        fppd.wait_for(lambda: ddr_frame(address) != black_a, timeout=15, what="the white frame to reach the DDR")
    fppd.command("Test Stop")
