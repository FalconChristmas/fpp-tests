"""Boot-time tools on an AM335x BeagleBone (BBB, PocketBeagle) in the fppinit
sandbox (fppinit.py): fpprtc and cape detection, built for the BeagleBone
platform, against planted devices and stubbed system tools.

Device only: the tools are only built for a BeagleBone on one. Run with
run-local.sh. Skipped elsewhere.
"""

import os

import pytest

from am335x import _am335x
from fppinit import fppinit  # noqa: F401 -- the fixture


def needs_bb_tool(fppinit, tool):
    if not _am335x():
        pytest.skip("needs an AM335x BeagleBone")
    if not os.path.exists(os.path.join(fppinit.tree, "src", tool)):
        pytest.skip(f"no {tool} in the tree under test")


def test_fpprtc_copies_the_cape_clock_into_the_built_in_rtc(fppinit):
    """On a BeagleBone whose rtc0 is the SoC's own clock (omap_rtc, not
    battery backed) and whose cape clock is rtc1, fpprtc reads the time
    from rtc1 ("hwclock -s -f /dev/rtc1") and then sets rtc0 from it
    ("hwclock -w -f /dev/rtc0").

    Regression: b94475275. The second call was "hwclock -w -f /dev/rtc1":
    it wrote the cape's clock back to itself, so the built-in one was never
    set.
    """
    needs_bb_tool(fppinit, "fpprtc")
    fppinit.settings(piRTC="2")  # DS1307
    fppinit.fake_path("/sys/class/rtc", {"rtc0/name": "omap_rtc\n"})
    fppinit.root_file("/dev/rtc0", "")
    fppinit.root_file("/dev/rtc1", "")
    r = fppinit._run(["/opt/fpp/src/fpprtc"], timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    hw = [c for c in fppinit.calls() if c.startswith("hwclock")]
    assert hw == ["hwclock -s -f /dev/rtc1", "hwclock -w -f /dev/rtc0"], (hw, r.stdout + r.stderr)


PINCTRL_LOG = "/pinctrl-calls.log"


def stub_pinctrl(fppinit, modes):
    """A /usr/bin/pinctrl that logs its calls and answers "-l <pin>" with
    the pin's mode from `modes` in brackets, as the real one marks the
    current mode."""
    cases = "\n".join(f'    {pin}) echo "gpio gpio_out gpio_pd gpio_pu i2c spi [{mode}]" ;;'
                      for pin, mode in modes.items())
    fppinit.root_file("/usr/bin/pinctrl", f"""#!/bin/sh
echo "$*" >> {PINCTRL_LOG}
if [ "$1" = -l ]; then
  case "$2" in
{cases}
  esac
fi
exit 0
""")


def stub_i2cdetect(fppinit, found_on=()):
    """An i2cdetect that finds the cape EEPROM (0x50) only on the buses in
    `found_on`."""
    buses = " ".join(str(b) for b in found_on) or "none"
    fppinit.root_file("/usr/sbin/i2cdetect", f"""#!/bin/sh
for b in {buses}; do
  if [ "$3" = "$b" ]; then echo "50: 50"; exit 0; fi
done
echo "50: --"
""")


def pinctrl_sets(fppinit):
    log = fppinit.written(PINCTRL_LOG) or ""
    return [l.split(None, 1)[1] for l in log.splitlines() if l.startswith("-s ")]


def i2c1_pins():
    from am335x import pocketbeagle
    return ("P2_09", "P2_11") if pocketbeagle() else ("P9_17", "P9_18")


def test_the_i2c1_probe_gives_its_pins_back_in_the_mode_they_had(fppinit):
    """With no cape EEPROM on i2c2, cape detection borrows the i2c1 pads
    (P9_17/P9_18 on a BBB, P2_09/P2_11 on a PocketBeagle) to look there,
    and finding nothing hands each back in the exact mode it had (here
    gpio_pu, as a cape's button pins are).

    Regression: 183327680 (the CapeUtils half). They were handed back as
    "default", which the pinctrl tool doesn't have, so the pads stayed
    muxed to i2c1 and a button's GPIO edges stopped.
    """
    needs_bb_tool(fppinit, "fppcapedetect")
    p1, p2 = i2c1_pins()
    stub_pinctrl(fppinit, {p1: "gpio_pu", p2: "gpio_pu", "P9_19": "i2c", "P9_20": "i2c"})
    stub_i2cdetect(fppinit)
    r = fppinit.capedetect(timeout=120)
    sets = pinctrl_sets(fppinit)
    for pin in (p1, p2):
        mine = [s for s in sets if s.startswith(pin + " ")]
        assert mine and mine[0] == f"{pin} i2c" and mine[-1] == f"{pin} gpio_pu", (sets, r.stdout[-2000:])


def test_cape_detection_muxes_i2c2_and_restores_it_when_the_eeprom_is_on_i2c1(fppinit):
    """On a BBB whose i2c2 pads (P9_19/P9_20) are not muxed for i2c, cape
    detection muxes them to i2c to look for the EEPROM there; found on
    i2c1 instead, it puts them back in the mode they had.

    Regression: e0b55ace2 (the CapeUtils half). With the base overlay's
    pinmux helpers gone nothing muxed i2c2 at boot, so the EEPROM on i2c2
    was never seen.
    """
    needs_bb_tool(fppinit, "fppcapedetect")
    from am335x import pocketbeagle
    if pocketbeagle():
        pytest.skip("the i2c2 pads are muxed by CapeUtils on a BBB only")
    stub_pinctrl(fppinit, {"P9_17": "gpio", "P9_18": "gpio", "P9_19": "gpio", "P9_20": "gpio"})
    stub_i2cdetect(fppinit, found_on=(1,))
    r = fppinit.capedetect(timeout=120)
    sets = pinctrl_sets(fppinit)
    for pin in ("P9_19", "P9_20"):
        mine = [s for s in sets if s.startswith(pin + " ")]
        assert mine == [f"{pin} i2c", f"{pin} gpio"], (sets, r.stdout[-2000:])


def test_the_base_overlay_leaves_the_pocketbeagle_pru_pads_alone(tmp_path):
    """The tree's base overlay (capes/drivers/bbb/fpp-base-overlay.dts),
    built as its Makefile builds it and applied to the running kernel's
    PocketBeagle dtb as u-boot applies it, leaves pru0 and pru1 with an
    empty "default" pin group: nothing muxes P2-28 and the other eight
    P1/P2 pads to the PRUs when the PRU device probes.

    Regression: ebb077b4c. The base dtb's PRU pin group was left in place;
    P2-28 then sat low as a PRU output, and a PocketScroller v2, which
    gates its i2c2 buffer with that pin, lost its EEPROM and OLED.
    """
    import subprocess
    import shutil
    from am335x import pocketbeagle
    if not _am335x() or not pocketbeagle():
        pytest.skip("needs an original PocketBeagle")
    tree = os.environ.get("FPP_TREE", "/opt/fpp")
    src = os.path.join(tree, "capes", "drivers", "bbb")
    dtb = f"/boot/dtbs/{os.uname().release}/am335x-pocketbeagle.dtb"
    base = None
    with open(os.path.join(src, "Makefile")) as f:
        for line in f:
            if line.startswith("DTD_BASE"):
                base = line.split(":=", 1)[1].strip()
    for tool in ("cpp", "dtc", "fdtoverlay", "fdtget"):
        if not shutil.which(tool):
            pytest.skip(f"no {tool}")
    if not base or not os.path.isdir(base) or not os.path.exists(dtb):
        pytest.skip("no device-tree sources or base dtb to build against")
    pre, ovl, merged = (str(tmp_path / n) for n in ("ovl.dts", "ovl.dtb", "merged.dtb"))
    with open(pre, "w") as out:
        subprocess.run(["cpp", f"-I{base}/include/", f"-I{base}/src/arm/ti/omap", "-nostdinc", "-undef",
                        "-x", "assembler-with-cpp", os.path.join(src, "fpp-base-overlay.dts")],
                       stdout=out, check=True, cwd=src)
    subprocess.run(["dtc", "--include", f"{base}/include/", "--include", f"{base}/src/arm/ti/omap",
                    "-O", "dtb", "-o", ovl, pre], check=True, capture_output=True)
    subprocess.run(["fdtoverlay", "-i", dtb, "-o", merged, ovl], check=True)

    def get(path, prop):
        return subprocess.run(["fdtget", "-t", "x", merged, path, prop],
                              capture_output=True, text=True).stdout.strip()

    for pru in ("pru0", "pru1"):
        path = subprocess.run(["fdtget", merged, "/__symbols__", pru], capture_output=True,
                              text=True, check=True).stdout.strip()
        assert get(path, "pinctrl-0") == "", (pru, get(path, "pinctrl-0"))


# ---- an I2S audio cape whose card binds late ----------------------------------

CARD_LINE = " 0 [PCM5102a       ]: simple-card - PCM5102a\n                      PCM5102a\n"


def audio_cape(fppinit, bind_on=None, bind_after=None):
    """A board whose device tree declares a sound card (an I2S audio cape),
    with no card registered yet. The card registers in the sandbox's
    /proc/asound/cards when the stubbed modprobe is asked for the module
    named `bind_on` (the machine driver), or `bind_after` seconds after
    setupAudio first lists the cards. aplay -l lists whatever has
    registered."""
    with open("/proc/device-tree/model") as f:
        model = f.read()
    with open("/proc/device-tree/compatible", "rb") as f:
        compatible = f.read().decode("latin-1")
    # /proc/device-tree is a link to this, resolved inside the sandbox
    fppinit.fake_path("/sys/firmware/devicetree/base", {"model": model, "compatible": compatible,
                                            "sound/status": "okay",
                                            "sound/compatible": "simple-audio-card\0"})
    fppinit.fake_path("/proc/asound", {"cards": "--- no soundcards ---\n"})
    fppinit.fake_path("/sys/bus/platform/devices", {
        "48038000.mcasp/modalias": "of:NmcaspT(null)Cti,am33xx-mcasp-audio\n",
        "sound/modalias": "of:NsoundT(null)Csimple-audio-card\n",
        "44e07000.gpio/modalias": "of:NgpioT(null)Cti,omap4-gpio\n",
        "44e07000.gpio/driver": "",
    })
    fppinit.fake_path("/sys/bus/usb/devices", {})
    register = f'printf "%s" {CARD_LINE!r} > /proc/asound/cards'
    fppinit.root_file("/usr/sbin/modprobe", f"""#!/bin/sh
echo "modprobe $*" >> /fppinit-calls.log
case "$*" in *{bind_on or "-none-"}*) {register} ;; esac
exit 0
""")
    late = ""
    if bind_after:
        late = f"""[ -e /tmp/bind-started ] || {{ touch /tmp/bind-started; ( sleep {bind_after}; {register} ) > /dev/null 2>&1 & }}"""
    fppinit.root_file("/usr/bin/aplay", f"""#!/bin/sh
echo "aplay $*" >> /fppinit-calls.log
{late}
if grep -q PCM5102a /proc/asound/cards; then
  echo "**** List of PLAYBACK Hardware Devices ****"
  echo "card 0: PCM5102a [PCM5102a], device 0: davinci-mcasp.0-pcm5102a-hifi pcm5102a-hifi-0 [davinci-mcasp.0-pcm5102a-hifi pcm5102a-hifi-0]"
  echo "  Subdevices: 1/1"
else
  echo "aplay: device_list:274: no soundcards found..."
fi
""")


def modprobes(fppinit):
    return [c for c in fppinit.calls() if c.startswith("modprobe ")]


def test_setup_audio_loads_the_cape_cards_cpu_dai_and_machine_driver(fppinit):
    """On a board whose cape card can only bind once the McASP (CPU DAI)
    and simple-audio-card (machine) drivers are loaded, setupAudio
    modprobes the still-unbound audio devices' modaliases itself: the card
    registers as card 0 and snd-dummy is never loaded.

    Regression: 12b948b50. setupAudio only waited for udev, which on a
    one-core BeagleBone loads those drivers tens of seconds into boot; it
    gave up after 5 s and took snd-dummy, so the cape card came up behind
    it as card 1.
    """
    needs_bb_tool(fppinit, "fppinit")
    audio_cape(fppinit, bind_on="simple-audio-card")
    r = fppinit.run("setupAudio", timeout=180)
    out = r.stdout + r.stderr
    mods = modprobes(fppinit)
    assert any("am33xx-mcasp-audio" in m for m in mods), (mods, out[-3000:])
    assert not any("snd-dummy" in m or "snd_dummy" in m for m in mods), (mods, out[-3000:])
    assert "Soundcard registered after" in out, out[-3000:]


def test_setup_audio_waits_for_a_cape_card_that_binds_late(fppinit):
    """A cape card that the device tree declares but that registers 2 s
    into setupAudio is waited for: it becomes card 0 and snd-dummy is not
    loaded.

    Regression: 864782476. With no card registered at that moment
    setupAudio loaded snd-dummy at once, which took card 0, and the cape
    card landed behind it.
    """
    needs_bb_tool(fppinit, "fppinit")
    audio_cape(fppinit, bind_after=2)
    r = fppinit.run("setupAudio", timeout=180)
    out = r.stdout + r.stderr
    mods = modprobes(fppinit)
    assert not any("snd-dummy" in m or "snd_dummy" in m for m in mods), (mods, out[-3000:])
    assert "Soundcard registered after" in out, out[-3000:]
