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

from am335x import pocketbeagle, write_string_cape
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


# 25 BeagleBone Black header pins on GPIO1-3 (no GPIO0, so one PRU drives
# them all): the first 25 outputs of a K32A-B
BBB_25_GPIO123_PINS = ["P8-45", "P8-46", "P8-43", "P8-44", "P8-42", "P8-40", "P8-38", "P8-36",
                       "P8-08", "P8-07", "P8-30", "P8-27", "P8-28", "P8-10", "P8-09", "P8-18",
                       "P9-25", "P8-37", "P8-34", "P8-29", "P8-26", "P8-16", "P8-39", "P8-41",
                       "P9-16"]


def test_the_ddr_part_of_a_frame_reaches_the_pru_at_every_colour_change(real_pru_am335x, fppd):
    """25 ports of 350 pixels under a whole-range colour cycle: every byte
    the PRU reads from DDR holds the frame fppd sent, at every frame.

    Regression: d3d04fafe (GH #3200). The DDR region was mapped cacheable,
    and BBB48String read its frame buffers every frame (the memcmp that
    decides whether to refresh the PRU memories, and the copy into them,
    over the first 27.5KB). Those lines stayed in the CPU cache, so the next
    frame's writes to them sat there instead of reaching DDR, where the PRU
    reads. The firmware takes most of that span from PRU memory, but at 25
    outputs (built as 28) it switches to DDR at byte 980 of each string, and
    bytes 980-985 -- pixels 327-329 of every port -- went out stale for a
    frame or more at each colour change.

    The check reads the frame through a non-cacheable mapping, so it sees
    what the PRU sees. Every pixel of a string is the same colour here, so
    each byte must equal the same channel ten pixels on (bytes past 1015
    were never in the cached span: the reference is always good). Without
    the fix 2-50% of frames fail on a BeagleBone Black (never fewer than
    six in 15s); this watches 30s of four colour changes a second.

    BeagleBone Black only (the pins); needs a cape licensed for every
    output, as the device's signed EEPROM is. Device only: run-local.sh
    --host-pru.
    """
    if pocketbeagle():
        pytest.skip("uses BeagleBone Black header pins")
    outputs, pixels = len(BBB_25_GPIO123_PINS), 350
    write_string_cape("TestCache", {"outputs": [{"pin": p} for p in BBB_25_GPIO123_PINS]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestCache",
        [pixel_output(i, pixels, i * pixels * 3) for i in range(outputs)]))
    fppd.start()
    fppd.wait_for(lambda: core_state(1) == "running", timeout=60, what="PRU1 to be running the strings program")
    capped = [w for w in fppd.get("/fppd/status").get("warnings", []) if "is licensed for" in w]
    if capped:
        pytest.skip(f"the cape is not licensed for full-length strings: {capped[0]}")

    stride = 28                  # the firmware's OUTPUTS: 25 rounded up to a multiple of 4
    first, last, ref = 980, 1015, 30
    fppd.command("Test Start", "250", "RGB Cycle", "*", "R-G-B-All")
    frames = stale = 0
    stale_bytes = {}
    with Pruss() as pruss:
        fppd.wait_for(lambda: pruss.dram(1, ADDRESS_DMA) >= 0x80000000, timeout=30, what="PRU1 to take a frame")
        seen = None
        end = time.monotonic() + 30
        while time.monotonic() < end:
            address = pruss.dram(1, ADDRESS_DMA)
            if address == seen:
                time.sleep(0.0005)
                continue
            # the PRU reaches these bytes ~9ms into the frame, long after
            # fppd has written it; read it before the next frame replaces it
            time.sleep(0.002)
            if pruss.dram(1, ADDRESS_DMA) != address:
                continue
            seen = address
            lo = first * stride
            blob = ddr_frame(address + lo, (last + ref + 1) * stride - lo + 4)
            frames += 1
            bad = 0
            for k in range(first, last + 1):
                for s in range(outputs):
                    if blob[k * stride + s - lo] != blob[(k + ref) * stride + s - lo]:
                        bad += 1
                        stale_bytes[k] = stale_bytes.get(k, 0) + 1
            stale += bad > 0
    fppd.command("Test Stop")
    assert frames > 30, f"only {frames} frames seen: the frame rate is not what the check assumes"
    assert not stale, (f"{stale} of {frames} frames had stale bytes in DDR: by string byte "
                       f"(pixel) {[(k, k // 3 + 1, n) for k, n in sorted(stale_bytes.items())]}")
