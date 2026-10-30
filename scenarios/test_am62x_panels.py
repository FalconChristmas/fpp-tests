"""BBShiftPanel on an AM62x board: several matrices on one cape, panel
types, config warnings -- against PRUs that never answer (see bbcape.py) --
and, under run-local.sh --host-pru, what the real PRUs do (see pru.py).

Device only: run with run-local.sh on a PocketBeagle2 whose cape EEPROM
carries a "PocketScroller" panel config (16 outputs); the cases skip on any
other cape. The GPIO lines are the real ones, so stop the device's own fppd
first. Skipped elsewhere.
"""

import os
import time

import pytest

from bbcape import fake_pru
import pru
from pru import real_pru  # noqa: F401 (a fixture)
import shims

FM6126A = 1  # panelType: a shift panel whose init registers go out on output start


def matrix(start=1, outputs=(0,), **over):
    """One 64x32 1/16 scan matrix of the cape's panel config, a panel on
    each of `outputs` (0-based cape outputs), channels from `start`."""
    panels = [{"outputNumber": o, "panelNumber": 0, "colorOrder": "", "xOffset": 0,
               "yOffset": 32 * n, "orientation": "N", "row": n, "col": 0}
              for n, o in enumerate(outputs)]
    c = {"cfgVersion": 3, "type": "LEDPanelMatrix", "subType": "BBShiftPanel",
         "configName": "PocketScroller", "enabled": 1, "startChannel": start,
         "channelCount": 6144 * len(outputs),
         "ledPanelsWidth": 64, "ledPanelsHeight": 32 * len(outputs), "ledPanelsScan": 16,
         "panelWidth": 64, "panelHeight": 32, "panelScan": 16, "ledPanelsSize": "64x32x16",
         "colorOrder": "RGB", "gamma": "2.2", "brightness": 10,
         "ledPanelsLayout": f"1x{len(outputs)}", "ledPanelsOutputs": 16,
         "ledPanelsPanelsPerOutput": 16, "panelColorDepth": 8, "invertedData": 0,
         "panelOutputOrder": False, "panelOutputBlankRow": False, "panelRowAddressType": 0,
         "panelType": 0, "panelInterleave": "0", "panelDataLayout": 0, "panels": panels}
    c.update(over)
    return c


def panels_config(*matrices):
    return {"channelOutputs": list(matrices)}


def needs_panel_config(fppd):
    """Skip unless the cape's EEPROM carries the PocketScroller panel config:
    panel configs come only from the cape, and on any other one the output
    is refused before it reaches what these scenarios test."""
    if "Could not read panel pin configuration for PocketScroller" in fppd.log():
        pytest.skip("the cape has no PocketScroller panel config (not a panel cape)")


def save_outputs(fppd, cfg):
    """Save channeloutputs.json the way the UI does, in one rename, so fppd
    reloads it once."""
    tmp = fppd.write("config/channeloutputs.json.new", cfg)
    os.replace(tmp, os.path.join(fppd.media, "config", "channeloutputs.json"))


def warnings_of(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


SAME_OUTPUT = "Two LED panel matrices are both configured to use cape output 1"


def test_a_shared_output_warning_comes_down_when_the_config_is_fixed(fppd):
    """Two matrices both on cape output 1: the second is refused with a
    warning, and once a config with the second moved to output 2 is saved,
    the warning comes down with no restart.

    Regression: 511abb50f. BBShiftPanel raised its config warnings from
    Init() with a plain AddWarning(), which an output reload never
    retracts: the banner stayed over the fixed, working config until fppd
    restarted.
    """
    fake_pru(fppd)
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,)), matrix(6145, (0,))))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    assert any(SAME_OUTPUT in w for w in warnings_of(fppd)), warnings_of(fppd)
    save_outputs(fppd, panels_config(matrix(1, (0,)), matrix(6145, (1,))))
    fppd.wait_for(lambda: not any(SAME_OUTPUT in w for w in warnings_of(fppd)),
                  timeout=30, interval=1, what="the warning to come down")


def test_a_second_matrix_that_cannot_start_leaves_the_first_one_running(fppd):
    """An FM6126A matrix starts; a second matrix, on another output, whose
    rebuild of the shared PRU fails (here its PRU memory can't be mapped)
    is refused. Output then starts for the first one without crashing fppd.

    Regression: cb9aa6c0e. The failed rebuild had already deleted the PRU
    but left pruData pointing into its unmapped memory, so when output
    started the surviving FM6126A matrix sent its panel init registers
    through the deleted PRU: SIGSEGV on the output thread.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.write("config/channeloutputs.json", panels_config(
        matrix(1, (0,), panelType=FM6126A), matrix(6145, (1,), panelType=FM6126A)))
    so = shims.build("co_failprumap.c")
    # the first matrix's mapping goes through, the rebuild for the second fails
    fppd.start(timeout=60, preload=[so],
               extra_env={"CO_FAILPRUMAP_LEN": str(0x80000), "CO_FAILPRUMAP_SKIP": "1"})
    needs_panel_config(fppd)
    assert "could not map PRU memory" in fppd.log(), fppd.tail()
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    # the output thread starts a few seconds after the test does
    time.sleep(6)
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    fppd.get("/fppd/status")
    fppd.command("Test Stop")



def test_a_second_matrix_with_another_scan_is_refused(fppd):
    """Two matrices on one cape, on outputs 1 and 2, and a third on output 3
    with a different scan: the first two are taken, the third is refused
    with a warning naming the scan (the cape shifts one frame shape out of
    every output). Without a signed cape only output 1's panels are
    licensed, so the second matrix has none here; the check is the frame
    shape's, not the panels'.

    Feature: bd5dcc2fe. The cape could carry only one matrix: a second was
    a second owner of the same PRUs, whatever its shape.
    """
    fake_pru(fppd)
    other_scan = matrix(12289, (2,), ledPanelsScan=8, panelScan=8, ledPanelsSize="64x32x8")
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,)), matrix(6145, (1,)), other_scan))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    w = warnings_of(fppd)
    assert [x for x in w if "LED panel" in x] == [
        "All LED panel matrices on one cape must use the same panel scan; this matrix was not started."], w
    assert fppd.log().count("Init succeeded, adding to channel outputs") == 2, fppd.tail()


def test_a_pwm_panel_on_a_shared_panels_and_strings_cape_is_refused(fppd):
    """A PWM panel type (FM6363C) on a cape that shares its PRUSS with a
    string driver ("sharedPRUSS", here from the output config, which is
    honoured for bench testing) is refused with a warning: the PWM panels
    need PRU0 for their GCLK program, which the strings own.

    Feature: 000c18546 (the panel half; the string half is in
    test_am62x_strings.py).
    """
    fake_pru(fppd)
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,), panelType=3, sharedPRUSS=True)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    w = warnings_of(fppd)
    assert "PWM panel types cannot be used on a shared panels+strings cape" in w, w


def test_a_chain_too_long_for_60hz_is_warned_about(fppd):
    """Ten 64x32 panels chained on one output at 12 bit color: the refresh
    the stride schedule allows is below 60 Hz, and fppd says so in a
    warning, with the estimate.

    Feature: 95695b863. Such a layout simply flickered, with nothing to
    say why.
    """
    fake_pru(fppd)
    panels = [{"outputNumber": 0, "panelNumber": n, "colorOrder": "", "xOffset": 64 * n,
               "yOffset": 0, "orientation": "N", "row": 0, "col": n} for n in range(10)]
    fppd.write("config/channeloutputs.json", panels_config(matrix(
        1, (0,), channelCount=640 * 32 * 3, ledPanelsWidth=640, ledPanelsLayout="10x1",
        panelColorDepth=12, panels=panels)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    w = [x for x in warnings_of(fppd) if x.startswith("LED panel refresh rate is only ")]
    assert w and int(w[0].split("only ")[1].split("Hz")[0]) < 60, warnings_of(fppd)


def test_a_layout_with_an_empty_panel_slot_runs(fppd):
    """A matrix of two panels side by side with a panel's width of gap
    between them (a 3x1 grid with its middle cell empty): a third of its
    channels land on no panel. The output starts, logs how many are
    unmapped, and a test pattern runs over it without crashing fppd.

    Regression: 6b277b1bc. The unmapped channels kept the 0xFFFFFFFF fill
    in the channel offset map, and the prep loop scattered through it to
    wild addresses: fppd crash-looped on such layouts.
    """
    fake_pru(fppd)
    # both on output 1 (the only one an unsigned cape licenses), first and
    # third in its chain
    panels = [{"outputNumber": 0, "panelNumber": n, "colorOrder": "", "xOffset": 64 * n,
               "yOffset": 0, "orientation": "N", "row": 0, "col": n} for n in (0, 2)]
    fppd.write("config/channeloutputs.json", panels_config(matrix(
        1, (0,), channelCount=192 * 32 * 3, ledPanelsWidth=192, ledPanelsLayout="3x1", panels=panels)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(6)
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    fppd.get("/fppd/status")
    fppd.command("Test Stop")
    assert "6144 of 18432 channels are not mapped to any panel" in fppd.log(), fppd.tail()


# ---- on the real PRUs (run-local.sh --host-pru) --------------------------------


def run_a_test_pattern(fppd, seconds=3):
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    # the output thread starts a few seconds after the test does
    time.sleep(4 + seconds)


def test_the_oe_pru_stops_itself_with_the_display_off(real_pru, fppd):
    """A standard panel on the 16-output cape runs on two PRUs: PRU1
    shifts the data and PRU0 pulses OE. When fppd stops, PRU1 hands PRU0
    the exit command; PRU0 turns the display off and halts itself, so it
    is found sitting on its own HALT with OE high (off).

    Regression: e1d9c24dc. The shift firmware sent 0xFFFFFFF (seven Fs)
    where the OE firmware waits for 0xFFFFFFFF, so PRU0 took it as a
    brightness of about a second, turned the display on, and was halted by
    the host mid-pulse: a lit row left on the panels.
    """
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,))))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd)
    assert pru.core_state(0) == "running" and pru.core_state(1) == "running", \
        (pru.core_state(0), pru.core_state(1), fppd.tail())
    fppd.exit_expected = True
    assert fppd.stop() == 0, fppd.tail()
    halts = pru.halt_instructions("/opt/fpp/src/non-gpl/BBShiftPanel/BBShiftPanel_oe_prefetch.out")
    with pru.Pruss() as p:
        pc, r30 = p.pc(0), p.register(0, 30)
    assert pc in halts, f"PRU0 stopped at {pc}, not on a HALT ({halts}); r30 {r30:#x}"
    assert r30 & 1, f"PRU0 left OE low (display on): r30 {r30:#x}"


def test_the_prus_are_parked_while_nothing_is_output(real_pru, fppd):
    """With nothing to show, once the channel output thread goes idle both
    panel PRUs are halted (remoteproc still has them loaded), with OE high
    (display off); a test pattern starts them again and frames flow.

    Regression: 70dc0c253. The pump kept re-shifting the last (blank)
    frame for as long as fppd ran -- most of a core on a large chain --
    and the PRUs never stopped.
    """
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,))))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    with pru.Pruss() as p:
        fppd.wait_for(lambda: p.halted(0) and p.halted(1), timeout=30, interval=0.5,
                      what="both PRUs halted while idle "
                           f"(controls {p.control(0):#x} {p.control(1):#x})")
        assert pru.core_state(0) == "running" and pru.core_state(1) == "running"
        assert p.register(0, 30) & 1, f"parked with OE low: r30 {p.register(0, 30):#x}"
        frames = p.dram(1, pru.RING_FRAMES)
        run_a_test_pattern(fppd, seconds=2)
        assert not p.halted(1) and not p.halted(0)
        assert p.dram(1, pru.RING_FRAMES) - frames > 50, "no frames after the park"
    fppd.command("Test Stop")


def test_the_refresh_estimate_is_the_refresh_the_prus_reach(real_pru, fppd):
    """A four-panel chain at 12 bit color on the 16-output cape (the panels
    on output 1, the only one an unsigned cape licenses; the frame is
    shifted out of all 16): the PRUs' frame counter climbs at the refresh rate fppd logs as its estimate
    (within 3%), and in the two-PRU mode the shift PRU never has to wait
    for its data -- its ring-wait count stays put.

    Regression: 3ccdb641a. PRU1 read every block from the shared RAM ring
    itself, between pixels, and waited on it tens of thousands of times in
    10 s here; PRU0, idle between OE pulses, now keeps a block fetched
    ahead and hands it over through the scratchpad. (Its recalibrated
    cycles-per-pixel constants keep the estimate on the measured rate,
    which held on either side.)
    """
    panels = [{"outputNumber": o, "panelNumber": n, "colorOrder": "", "xOffset": 64 * n,
               "yOffset": 32 * o, "orientation": "N", "row": o, "col": n}
              for o in range(16) for n in range(4)]
    fppd.settings(LogLevel_ChannelOut="info")
    fppd.write("config/channeloutputs.json", panels_config(matrix(
        1, (0,), channelCount=256 * 512 * 3, ledPanelsWidth=256, ledPanelsHeight=512,
        ledPanelsLayout="4x16", panelColorDepth=12, panels=panels)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    est = [l for l in fppd.log().splitlines() if "est refresh" in l]
    assert est, fppd.tail()
    estimate = int(est[-1].split("est refresh ")[1].split(" Hz")[0])
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(6)
    with pru.Pruss() as p:
        stalls0, frames0, t0 = p.dram(1, pru.RING_STATS), p.dram(1, pru.RING_FRAMES), time.monotonic()
        time.sleep(10)
        stalls1, frames1, t1 = p.dram(1, pru.RING_STATS), p.dram(1, pru.RING_FRAMES), time.monotonic()
    fppd.command("Test Stop")
    refresh = (frames1 - frames0) / (t1 - t0)
    assert abs(refresh - estimate) <= 0.03 * estimate, f"estimated {estimate} Hz, the PRUs refresh at {refresh:.1f} Hz"
    assert stalls1 == stalls0, f"PRU1 waited {stalls1 - stalls0} times for data"


def test_a_panel_config_saved_while_outputting_keeps_refreshing(real_pru, fppd):
    """With a test pattern running, the panel config is saved again (as an
    upload from xLights does): the reloaded matrix picks up straight away,
    its PRUs running and rendering frames, with no stop and start of
    output.

    Regression: d61426c2e (the outputs half; the enable-pin half is in
    test_am62x_ports.py). The reload built the new output without the
    StartingOutput() the output thread had made when it came up, so it ran
    in the stopped state for the rest of its life: the PRUs parked and the
    panels dark.
    """
    cfg = panels_config(matrix(1, (0,)))
    fppd.write("config/channeloutputs.json", cfg)
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd, seconds=2)
    save_outputs(fppd, cfg)
    time.sleep(5)
    assert fppd.log().count("Calling Init() on BBShiftPanel output") == 2, "the config was not reloaded"
    with pru.Pruss() as p:
        frames = p.dram(1, pru.RING_FRAMES)
        time.sleep(2)
        assert not p.halted(1), f"PRU1 halted after the reload (control {p.control(1):#x})"
        assert p.dram(1, pru.RING_FRAMES) - frames > 50, "no frames after the reload"
    fppd.command("Test Stop")


# ---- panel types on the real PRUs -----------------------------------------------

PWM_CHIP_CONFIG = 0x1DF8   # PWM_CHIP_CONFIG_OFFSET / ADDR_CONFIG_OFFSET, PRU1 data RAM
PANEL_INIT = 0x1E00        # PANEL_INIT_OFFSET: the FM6126A-style init registers
FW = "/opt/fpp/src/non-gpl/BBShiftPanel/"


def installed_program(core):
    """The program image remoteproc last loaded on `core`: fppd installs it
    as /lib/firmware/am62x-pru<core>-fw.fpp."""
    with open(f"/lib/firmware/am62x-pru{core}-fw.fpp", "rb") as f:
        return f.read()


def image(name):
    with open(FW + name, "rb") as f:
        return f.read()


def panel_warnings(fppd):
    return [w for w in warnings_of(fppd) if "panel" in w.lower() or "BBShiftPanel" in w]


# panelType: (the chip config word the PWM firmware reads, its meaning)
PWM_TYPES = {
    3: (0x00000000, "FM6363C: five fixed registers"),
    4: (0x00000000, "FM6353: the FM6363C register grammar"),
    5: (0x000B0501, "FM6373: 5 slots, 11 clock middle LAT burst"),
    6: (0x00000101, "DP3364S: one register slot, no middle burst"),
    7: (0x000B0501, "ICND1065L: the FM6373 upload"),
    8: (0x00000601, "SM16380SH: 6 slots, no middle burst"),
    9: (0x00000000, "ICND2153: the FM6353 grammar"),
}


@pytest.mark.parametrize("ptype", sorted(PWM_TYPES), ids=lambda t: PWM_TYPES[t][1].split(":")[0])
def test_a_pwm_panel_type_runs_the_pwm_firmware(real_pru, fppd, ptype):
    """A 64x32 panel of each PWM panel type on the 16-output cape starts
    with no warning: PRU1 runs the PWM firmware and PRU0 the GCLK one, the
    chip config word PRU1 reads carries that chip's register upload shape,
    and the per-frame register/data commands keep being taken through a
    test pattern.

    Feature: 5f40c8ee2 (FM6363C as a panel type), 7ca1accf9 (FM6353),
    fedc205c1 (FM6373), 6db4a7122 (DP3364S), 73a166998 (ICND1065L,
    SM16380SH, ICND2153). Without a type's case in parsePanelParams() the
    panel runs as a plain shift panel: the shift firmware, nothing for the
    chip.
    """
    fppd.settings(LogLevel_ChannelOut="info")
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,), panelType=ptype)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd, seconds=3)
    assert installed_program(1) == image("BBShiftPanel_pwm_16.out"), "PRU1 is not running the PWM firmware"
    assert installed_program(0) == image("BBShiftPanel_gclk.out"), "PRU0 is not running the GCLK firmware"
    want, what = PWM_TYPES[ptype]
    with pru.Pruss() as p:
        assert p.dram(1, PWM_CHIP_CONFIG) == want, f"{what}: chip config {p.dram(1, PWM_CHIP_CONFIG):#010x}"
        assert not p.halted(0) and not p.halted(1)
    assert not panel_warnings(fppd), panel_warnings(fppd)
    assert "PWM panel registers were not sent" not in fppd.log()
    fppd.command("Test Stop")


def test_an_fm6126a_panel_gets_its_init_registers_when_output_starts(real_pru, fppd):
    """An FM6126A panel (a shift panel that shows nothing until its config
    registers are clocked in): when output starts, the two register writes
    (full brightness, panel on) are handed to PRU1 at PANEL_INIT_OFFSET and
    it takes the 0xFFF0 command that clocks them out.

    Feature: 77bde9eb2. The registers were never sent, so these panels
    stayed dark on a BeagleBone cape.
    """
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,), panelType=FM6126A)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd, seconds=2)
    assert "sent 2 panel init registers for panel type 1" in fppd.log(), fppd.tail()
    with pru.Pruss() as p:
        words = [p.dram(1, PANEL_INIT + 4 * n) for n in range(3)]
    # count | rowLen << 16, then leCount | pattern << 16 per register
    assert words[0] & 0xFFFF == 2 and words[0] >> 16 == 64, [hex(w) for w in words]
    assert words[1:] == [12 | (0xFFFE << 16), 13 | (0x0200 << 16)], [hex(w) for w in words]
    fppd.command("Test Stop")


@pytest.mark.parametrize("mode", [1, 3, 4], ids=["AB-shift", "ABC-shift", "SM5266P"])
def test_a_shift_register_row_addressing_mode_reaches_the_firmware(real_pru, fppd, mode):
    """A panel with row addressing mode 1 (AB shift register), 3 (ABC) or
    4 (SM5266P): the row config word PRU1 reads holds the mode and the 16
    scan rows, and frames keep coming through a test pattern.

    Feature: 5f40c8ee2. The modes did not exist; the firmware only wrote
    the row address straight onto the SEL pins.
    """
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,), panelRowAddressType=mode)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd, seconds=1)
    with pru.Pruss() as p:
        cfg = p.dram(1, PWM_CHIP_CONFIG)
        frames = p.dram(1, pru.RING_FRAMES)
        time.sleep(2)
        frames = p.dram(1, pru.RING_FRAMES) - frames
    assert cfg & 0xFFFF == mode | (16 << 8), f"row config {cfg:#010x}"
    assert frames > 50, f"{frames} frames in 2 s"
    assert not panel_warnings(fppd), panel_warnings(fppd)
    fppd.command("Test Stop")


# ---- the stride table PRU1 runs the rows from ------------------------------------

STRIDE_TABLE = 0x08  # BBShiftPanelData.brightness: {on time, blank flag | row << 24} per stride


def strides_per_row(fppd):
    """The strides (bit planes and their split pieces) a row is shown in,
    from fppd's schedule log line."""
    lines = [l for l in fppd.log().splitlines() if "strides/row" in l]
    assert lines, fppd.tail()
    return int(lines[-1].split("BBShiftPanel: ")[1].split(" strides/row")[0])


def stride_table(p, entries):
    """The first `entries` (on time, flags word) pairs of PRU1's stride table."""
    return [(p.dram(1, STRIDE_TABLE + 8 * e), p.dram(1, STRIDE_TABLE + 8 * e + 4)) for e in range(entries)]


def test_blank_between_rows_blanks_once_before_each_row(real_pru, fppd):
    """A 64x32 1/16 panel output by row with Blank Between Rows: PRU1's
    stride table runs row by row (each entry's address byte is its row),
    and the blank flag (bit 31, which makes the firmware shift out a
    black row first) is set on the first stride of each row and on no
    other.

    Regression: 70431457f. The flag was put on the last bit plane of each
    row (d == colorDepth - 1), so the blank came after the brightest
    stride rather than between rows. Coverage for c7c9023c7, which made
    output by row and blank between rows work on the shift panels at all
    (since rewritten; no revert of it applies).
    """
    fppd.settings(LogLevel_ChannelOut="info")
    fppd.write("config/channeloutputs.json", panels_config(matrix(
        1, (0,), panelOutputOrder=True, panelOutputBlankRow=True)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd, seconds=1)
    n = strides_per_row(fppd)
    with pru.Pruss() as p:
        table = stride_table(p, 16 * n)
    fppd.command("Test Stop")
    rows = [(flags >> 24) & 0x7F for _, flags in table]
    assert rows == [r for r in range(16) for _ in range(n)], f"not row by row: {rows}"
    blanked = [e for e, (_, flags) in enumerate(table) if flags & 0x80000000]
    assert blanked == [r * n for r in range(16)], f"blank flags on entries {blanked} ({n} strides/row)"


def test_a_panel_timing_file_sets_the_longest_on_time(real_pru, fppd):
    """config/panel_timing.txt (a hex PRU cycle count) replaces the maximum
    on time the stride schedule is built from: at full brightness the on
    times of a row's strides add up to that value halved bit plane by bit
    plane, not to the default for the chain length.

    Regression: 9078ac1f5 added the override (its stepped defaults are
    since a smooth ramp, 6b277b1bc); without it the file is ignored and
    the table carries the default 0x8800.
    """
    fppd.settings(LogLevel_ChannelOut="info")
    fppd.write("config/panel_timing.txt", "4000\n")
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,))))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd, seconds=1)
    n = strides_per_row(fppd)
    with pru.Pruss() as p:
        table = stride_table(p, 16 * n)
    fppd.command("Test Stop")
    # slot by slot, the 16 rows of each: row 0's strides are every 16th entry
    row0 = sum(on for on, _ in table[0::16])
    want = sum(0x4000 >> (7 - b) for b in range(8))
    default = sum(0x8800 >> (7 - b) for b in range(8))
    assert row0 == want, f"row 0 on times add up to {row0:#x}, want {want:#x} (default {default:#x})"


def test_direct_row_select_drives_one_select_line_low_per_row(real_pru, fppd):
    """Panel Addressing Type "Direct Row Select" (2, the value the page
    saves on a Pi and a Beagle alike): PRU1's stride table addresses rows
    0-3 with one select line low each (0x0E, 0x0D, 0x0B, 0x07), the
    later rows as plain row numbers.

    Regression: 285231911 (the BBShiftPanel half; the BBBMatrix half is in
    test_am335x_pru.py). The driver took 1 for Direct Row Select while the
    page saved 2, so the rows were sent as binary addresses.
    """
    fppd.settings(LogLevel_ChannelOut="info")
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,), panelRowAddressType=2)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd, seconds=1)
    n = strides_per_row(fppd)
    with pru.Pruss() as p:
        table = stride_table(p, 16 * n)
    fppd.command("Test Stop")
    rows = [(flags >> 24) & 0x7F for _, flags in table[:16]]
    assert rows == [0x0E, 0x0D, 0x0B, 0x07] + list(range(4, 16)), [hex(r) for r in rows]


def test_a_pwm_panel_at_full_brightness_gets_the_shortest_blanking(real_pru, fppd):
    """A PWM panel (FM6363C) at brightness 10: the GCLK program on PRU0 is
    configured with 3 blanking loops between GCLK packets (its brightness
    knob), the shortest it is given.

    Regression: bc48d41a5 (its brightness half; the thread pool half is a
    speed-up with nothing else to see). The loops were 11 - brightness, 1
    at full brightness, too short for the panel to latch -- dimmer, not
    brighter.
    """
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,), panelType=3, brightness=10)))
    fppd.start(timeout=60)
    needs_panel_config(fppd)
    run_a_test_pattern(fppd, seconds=2)
    with pru.Pruss() as p:
        # bytes: [0] blanking loops, [1] row select mode, [2]/[3] GCLK pulses
        loops = p.dram(0, 0) & 0xFF
        assert not p.halted(0), "the GCLK PRU is not running"
    fppd.command("Test Stop")
    assert loops == 3, f"GCLK blanking loops {loops}"
