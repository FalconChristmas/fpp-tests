"""The BeagleBone user LEDs (BBBLeds0-3 in the Settings page), as
`fppinit configureBBB` sets them -- the step that runs at boot and that
PutSetting runs the moment one of those settings changes -- in the fppinit
sandbox (fppinit.py), with /sys/class/leds a stand-in directory holding
the board's own LED names, each trigger file a copy of the real one (the
kernel's list of the triggers it offers, the current one in brackets), so
the LEDs themselves are never touched.

The receiving end is the kernel's LED trigger list: every trigger fppinit
writes, and every one the Settings page offers (GetOptions_BBBLeds, run
from the tree's options.php with php-cli), must be one this board's kernel
offers, read from the real /sys/class/leds/<led>/trigger (reading it
changes nothing).

Device only: needs a BeagleBone build of fppinit (PLATFORM_BBB or
PLATFORM_BB64) on a BeagleBone Black, PocketBeagle or PocketBeagle2; run
with run-local.sh.
"""

import json
import os
import re
import shutil
import subprocess

import pytest

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture

LEDS = "/sys/class/leds"
TREE = os.environ.get("FPP_TREE", "")


def board_leds():
    try:
        return sorted(n for n in os.listdir(LEDS) if n.startswith("beaglebone:green:usr"))
    except OSError:
        return []


def trigger_file(led):
    with open(os.path.join(LEDS, led, "trigger")) as f:
        return f.read()


def offered(led):
    """The triggers the kernel offers for this LED."""
    return re.sub(r"[\[\]]", "", trigger_file(led)).split()


def pocketbeagle2():
    try:
        with open("/proc/device-tree/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


pytestmark = pytest.mark.skipif(len(board_leds()) != 4, reason="a BeagleBone's four user LEDs")


def configure(sb, monkeypatch, **settings):
    """Run configureBBB; for each LED, what it wrote, or None when it left
    the trigger file as the kernel had it."""
    leds = board_leds()
    real = {led: trigger_file(led) for led in leds}
    sb.fake_path(LEDS, {f"{led}/trigger": real[led] for led in leds})
    sb.settings(**settings)
    # A PocketBeagle2 also checks its identity EEPROM here: give it a
    # healthy one, so the repair script is never forked (test_fppinit_bb64.py).
    sb.write_bytes("pb2-eeprom.bin", b"\xaa\x55" + b"\0" * 48 + b"000123" + b"\0" * 200)
    monkeypatch.setenv("PB2_EEPROM", f"{MEDIA}/pb2-eeprom.bin")
    r = sb.run("configureBBB")
    written = {}
    for led in leds:
        now = sb.faked(LEDS, f"{led}/trigger")
        written[led] = None if now == real[led] else now.strip()
    return written, r.stdout + r.stderr


def test_the_led_settings_are_applied_with_triggers_the_kernel_offers(fppinit, monkeypatch):
    """configureBBB writes each LED's trigger from its setting, in the
    board's LED order (usr0-3 on an AM335x board, usr1-4 on a
    PocketBeagle2), and every one is a trigger this board's kernel offers
    for that LED: "CPU Activity" (cpu) is "activity" on a PocketBeagle2,
    whose kernel has no cpu trigger -- for the fourth LED too.

    Regression: e28eddf0f. The LEDs were set only at boot (no configureBBB
    action for PutSetting to run, so a change needed a reboot), and "cpu"
    went to a PocketBeagle2 as it was, which its kernel refuses.
    Regression: 51ceb5ce4. The fourth LED's setting skipped that mapping.
    """
    written, out = configure(fppinit, monkeypatch, BBBLeds0="none", BBBLeds1="heartbeat",
                             BBBLeds2="cpu", BBBLeds3="cpu")
    leds = board_leds()
    assert written[leds[0]] == "none", (written, out[-3000:])
    assert written[leds[1]] == "heartbeat", (written, out[-3000:])
    for led in leds[2:]:
        # Which one "CPU Activity" is depends on the board.
        assert written[led] in ("cpu", "activity"), (written, out[-3000:])
    for led, trigger in written.items():
        assert trigger in offered(led), f"{led}: {trigger!r} is not one of {offered(led)}"


def test_unset_leds_get_the_defaults_their_kernel_offers(fppinit, monkeypatch):
    """With no LED settings (a fresh install), configureBBB puts each LED
    back to its default -- heartbeat, mmc0, CPU activity, mmc1 -- rather
    than leaving whatever an earlier setting turned it to until a reboot;
    a default this board's kernel doesn't offer (mmc1, eMMC activity, on an
    original PocketBeagle, which has no eMMC) is not written.

    Regression: e28eddf0f. An LED whose setting was empty was not written,
    so going back to the default needed a reboot.
    Regression: 51ceb5ce4. mmc1 was written on every board; a PocketBeagle's
    kernel refused it and the LED kept whatever trigger it had.
    """
    written, out = configure(fppinit, monkeypatch)
    leds = board_leds()
    defaults = ["heartbeat", "mmc0", "activity" if pocketbeagle2() else "cpu", "mmc1"]
    for led, want in zip(leds, defaults):
        if want in offered(led):
            assert written[led] == want, (led, written, out[-3000:])
        else:
            assert written[led] is None, f"{led}: wrote {written[led]!r}, which the kernel doesn't offer"


# GetOptions_BBBLeds(), taken out of the tree's options.php as it is and run
# on its own (the rest of the controller needs Apache).
OPTIONS = r"""<?php
$src = file_get_contents(getenv('FPP_TREE') . '/www/api/controllers/options.php');
if (!preg_match('/^function GetOptions_BBBLeds\(\).*?^}/ms', $src, $m)) { fwrite(STDERR, "no GetOptions_BBBLeds\n"); exit(2); }
function json($a) { return json_encode($a); }
$settings = array('Platform' => $argv[1]);
eval($m[0]);
echo GetOptions_BBBLeds();
"""


def test_the_led_choices_offered_are_triggers_the_kernel_offers(tmp_path):
    """The Settings page's LED choices (GetOptions_BBBLeds) are triggers
    this board's kernel offers -- CPU Activity standing for "activity" where
    the kernel has that instead of cpu: no eMMC Activity on an original
    PocketBeagle.

    Regression: 51ceb5ce4. eMMC Activity (mmc1) was offered on every board.
    """
    if not shutil.which("php") or not os.path.exists(os.path.join(TREE, "www", "api", "controllers", "options.php")):
        pytest.skip("needs php-cli and an fpp tree")
    driver = tmp_path / "options.php"
    driver.write_text(OPTIONS)
    platform = "BeagleBone 64" if pocketbeagle2() else "BeagleBone Black"
    r = subprocess.run(["php", str(driver), platform], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    choices = json.loads(r.stdout)
    # The control: the choices every board has.
    assert choices.get("Disabled") == "none" and choices.get("Heartbeat") == "heartbeat", choices
    kernel = offered(board_leds()[0])
    for label, value in choices.items():
        ok = value == "none" or value in kernel or (value == "cpu" and "activity" in kernel)
        assert ok, f"{label} ({value}) is offered, but the kernel's triggers are {kernel}"
