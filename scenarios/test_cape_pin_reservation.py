"""Which of a pixel cape's pins are kept from other uses: the GPIO page's
reserved list (www/gpio.php) and the pads fppd's DPIPixels output muxes.

A cape with a physical EEPROM has every pin wired to an output buffer, so
all of them are taken even for empty ports. A virtual EEPROM describes a
hand-wired setup, where only the ports with pixels are.

The GPIO page's block runs anywhere with php-cli (taken out of the tree's
gpio.php, as test_storage_tab.py does). The fppd half needs a Raspberry Pi
(DPIPixels is built only there), run with run-local.sh: fakedrm.so gives it a
DPI-1 connector and run-local.sh's pinctrl stub records the pads it muxes.
There the device's own cape EEPROM is virtual (run-local.sh offers it as
config/cape-eeprom.bin), or physical when put back on a stand-in bus as
test_dpi_smart_receivers.py does.
"""

import json
import os
import shutil
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")

CAPE = {"name": "TestHat", "driver": "DPIPixels", "outputs": [{"pin": "P1-7"}, {"pin": "P1-29"}]}


def string(port, pixels):
    return {"portNumber": port, "protocol": "ws2811", "virtualStrings": [
        {"description": f"port{port}", "startChannel": port * 30, "pixelCount": pixels, "groupCount": 0,
         "reverse": 0, "colorOrder": "RGB", "nullNodes": 0, "endNulls": 0, "zigZag": 0,
         "brightness": 100, "gamma": "1.0"}]}


# Port 1 has pixels, port 2 none.
PIXEL_STRINGS = {"channelOutputs": [
    {"type": "DPIPixels", "subType": "TestHat", "enabled": 1, "startChannel": 1,
     "channelCount": 60, "outputCount": 2, "outputs": [string(0, 10), string(1, 0)]}]}


def reserved_pins(tmp_path, eeprom_location):
    """The pins gpio.php's top block reserves, for a cape whose EEPROM is at
    eeprom_location."""
    php = shutil.which("php")
    if not php:
        pytest.skip("no php-cli here")
    with open(os.path.join(TREE, "www", "gpio.php")) as f:
        src = f.read()
    i = src.find("$capeInputsFile = ")
    j = src.find("?>", i)
    assert i >= 0 and j > i, "gpio.php has no pin reservation block"
    media = tmp_path / "media"
    (media / "tmp" / "strings").mkdir(parents=True)
    (media / "config").mkdir()
    (media / "tmp" / "cape-info.json").write_text(json.dumps(
        {"id": "TestHat", "name": "TestHat", "eepromLocation": eeprom_location}))
    (media / "tmp" / "strings" / "TestHat.json").write_text(json.dumps(CAPE))
    (media / "config" / "co-pixelStrings.json").write_text(json.dumps(PIXEL_STRINGS))
    script = tmp_path / "gpio.php"
    script.write_text(f"<?php\n$mediaDirectory = '{media}';\n" + src[i:j] +
                      "\necho json_encode($usedGpioPins);\n")
    r = subprocess.run([php, str(script)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stdout + r.stderr
    return json.loads(r.stdout)


@pytest.mark.parametrize("location,pins", [
    ("/home/fpp/media/config/cape-eeprom.bin", ["P1-7"]),
    ("/sys/bus/i2c/devices/1-0050/eeprom", ["P1-29", "P1-7"]),
], ids=["virtual", "physical"])
def test_the_gpio_page_reserves_only_a_virtual_capes_used_ports(tmp_path, location, pins):
    """A two-port DPIPixels cape with pixels on port 1 only: with a virtual
    EEPROM the GPIO page reserves port 1's pin and leaves port 2's free for
    an input; with a physical EEPROM it reserves both.

    Regression: 0952d9694 (the GPIO page's half). Every pin of a virtual
    cape was reserved, so a hand-wired hat with three of its 24 ports in
    use left none of the rest for GPIO inputs.
    """
    assert sorted(reserved_pins(tmp_path, location)) == pins


@pytest.mark.parametrize("eeprom,gpios", [("virtual", ["4"]), ("physical", ["4", "5"])],
                         ids=["virtual", "physical"])
def test_dpipixels_muxes_only_a_virtual_capes_used_ports(fppd, eeprom, gpios):
    """The same cape driven by fppd: with the device's EEPROM offered as a
    virtual one, DPIPixels hands only port 1's pad (GPIO4) to the DPI and
    leaves port 2's (GPIO5) alone; with the EEPROM found on the bus, both.

    Regression: 0952d9694 (fppd's half). Every pin a virtual cape listed
    was muxed to the DPI.
    """
    import fakedrm
    import hosttools
    from test_dpi_pixels import on_pi, write_cape
    from test_dpi_smart_receivers import signed_cape_env
    if not on_pi():
        pytest.skip("DPIPixels is built for a Raspberry Pi")
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's pinctrl stub (no --host-pinctrl)")
    write_cape("TestHat", CAPE)
    fppd.write("config/co-pixelStrings.json", PIXEL_STRINGS)
    fppd.settings(LogLevel_ChannelOut="info")
    preload, env = fakedrm.dpi_env(fppd)
    if eeprom == "physical":
        more, more_env = signed_cape_env(fppd)
        preload += more
        env.update(more_env)
    calls = hosttools.pinctrl_calls()
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    fppd.wait_for(lambda: [c for c in calls.calls() if c.split()[:2] == ["set", "4"]], timeout=5,
                  what="pinctrl to be asked to mux GPIO4")
    muxed = sorted({c.split()[1] for c in calls.calls() if c.split()[:1] == ["set"] and len(c.split()) > 2})
    assert muxed == gpios, f"muxed GPIOs {muxed}, want {gpios}, for a {eeprom} cape with pixels on port 1 only"
