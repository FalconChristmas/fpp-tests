"""fppoled's pages on a fake SSD1306 (oled.py): the H-flipped display types,
the boot notice's cape logo cached from the last boot, scrolling the sensors
page, and backing out of the Reset prompt.

The buttons are gpio.json OLED Navigation inputs on free Raspberry Pi header
lines, pressed by flipping their pads' pulls with the real pinctrl (as in
test_oled_expander_buttons.py).

Device only: run-local.sh on a Pi (fppoled isn't built in a container).
"""

import json
import os
import subprocess
import time

import pytest

import hosttools
import oled
import shims
from test_oled import lit, oled_media, screen  # noqa: F401 -- fixtures
from test_oled_expander_buttons import held_by_fppoled, lines, main_menu, nav, pull
from test_pi_gpio_inputs import on_pi

pytestmark = pytest.mark.skipif(not on_pi(), reason="Raspberry Pi header lines")

XBM = ("#define cape_width 8\n#define cape_height 8\n"
       "static unsigned char cape_bits[] = {\n"
       "   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, };\n")


def mirrored(f):
    """The frame as it reads in a mirror: each page's 128 columns reversed."""
    data = b"".join(f.page(p)[::-1] for p in range(8))
    return oled.Frame(f.ms, data, f.glyphs)


def buttons(oled_media, *actions):
    """gpio.json OLED buttons, one per action (falling edge, pulled up), on
    free header lines. Returns {action: gpio}."""
    pins = lines(len(actions))
    oled_media.put("config/gpio.json", json.dumps([
        {"pin": p, "enabled": True, "mode": "gpio_pu", "rising": [], "falling": nav(a)}
        for (p, _), a in zip(pins, actions)]))
    return {a: g for (_, g), a in zip(pins, actions)}


def press(gpio):
    pull(gpio, "pd")
    time.sleep(0.15)
    pull(gpio, "pu")
    time.sleep(0.5)


def wait_held(screen, *gpios):
    deadline = time.monotonic() + 30
    while not held_by_fppoled(*gpios):
        if time.monotonic() > deadline or screen.proc.poll() is not None:
            pytest.fail(f"fppoled never held {gpios}\n{screen.log()}")
        time.sleep(0.2)


def test_an_h_flipped_display_draws_mirrored(screen, fppd, oled_media):
    """LEDDisplayType 32, "128x64 H-Flipped I2C (SSD1306)", draws every
    page mirrored left to right: the status page's "No Network" reads
    right in a mirror, and not as drawn.

    Regression: 2c1d7dbd5, which added the H-flipped types (32, and 33 for
    the two-colour panel); before it a type above 10 got no display.
    """
    oled_media.settings(LEDDisplayType=32)
    fppd.start()
    screen.start()
    f = screen.wait_for(lambda f: mirrored(f).line(0) == "No Network", timeout=20,
                        what='"No Network" mirrored on the top line')
    assert f.line(0) != "No Network", f.text()


@pytest.fixture
def private_var_tmp():
    """/var/tmp as an empty tmpfs for this test only (run-local.sh's mount
    namespace keeps it from the device), unmounted after."""
    subprocess.run(["mount", "-t", "tmpfs", "tmpfs", "/var/tmp"], check=True)
    try:
        yield "/var/tmp"
    finally:
        subprocess.run(["umount", "-l", "/var/tmp"])


def test_the_boot_notice_draws_the_logo_cached_from_the_last_boot(oled_media, screen, private_var_tmp):
    """While cape detection hasn't run yet (media/tmp has no cape image),
    the "FPP - Cape Detection" notice draws the cape logo the last boot
    left in /var/tmp/cape-image.xbm.

    Regression: 70763d20e. The notice only looked in media/tmp, which is
    empty until detection has run, so the logo appeared only once boot was
    nearly over. (The copy moved from /tmp to /var/tmp in 94e34a68e's
    time, so it outlives a reboot.)
    """
    with open(os.path.join(private_var_tmp, "cape-image.xbm"), "w") as f:
        f.write(XBM)
    oled_media.put("tmp/cape-image.xbm", None)
    oled_media.put("tmp/cape_detect_done", None)
    screen.start()
    f = screen.wait_for(lambda f: f.line(0).startswith("FPP - Cape"), timeout=10,
                        what="the cape detection notice")
    assert lit(f, 0, 20, 8, 8) == 64, f.text()


def sensor_rows(f):
    """The sensor labels down the frame, top to bottom, as drawn."""
    return [t.split(":")[0] for t in (f.text_at(y) for y in range(64))
            if t[:4] in ("AAA:", "BBB:", "CCC:")]


def test_the_sensors_page_scrolls_with_down_and_up(oled_media, screen, fppd):
    """On the sensors page, Down moves the list up a line (the top sensor
    goes to the bottom) and Up moves it back.

    Regression: 432f067b7, which added the scrolling; before it Down and
    Up did nothing there, so sensors below the panel's last line could not
    be seen. (Its other half, a status request updating only the sensor
    sources that report, isn't covered.)
    """
    base = os.path.join(fppd.media, "fakesys", "thermal")
    for i, name in enumerate(("aaa", "bbb", "ccc")):
        fppd.write(f"fakesys/thermal/thermal_zone{i}/temp", "42000\n")
        fppd.write(f"fakesys/thermal/thermal_zone{i}/type", f"{name}-thermal\n")
    fppd.start(preload=[shims.build("fakesys.c")], extra_env={"FAKESYS": f"/sys/class/thermal={base}"})
    # the fake zones in place of the real one (a fan, if the board has one,
    # comes after them)
    labels = [s["label"] for s in fppd.get("/fppd/status").get("sensors", [])]
    assert labels[:3] == ["AAA: ", "BBB: ", "CCC: "], labels
    keys = buttons(oled_media, "Enter", "Down", "Up")
    with hosttools.pads_kept(keys.values()):
        screen.start()
        wait_held(screen, *keys.values())
        for g in keys.values():
            pull(g, "pu")
        screen.wait_for(lambda f: f.line(0) == "No Network", timeout=20, what="the status page")
        press(keys["Enter"])
        screen.wait_for(lambda f: sensor_rows(f) == ["AAA", "BBB", "CCC"], timeout=5,
                        what="the sensors page")
        press(keys["Down"])
        screen.wait_for(lambda f: sensor_rows(f) == ["BBB", "CCC", "AAA"], timeout=5,
                        what="the list scrolled one line by Down")
        press(keys["Up"])
        screen.wait_for(lambda f: sensor_rows(f) == ["AAA", "BBB", "CCC"], timeout=5,
                        what="the list back by Up")


@pytest.fixture
def no_reboot():
    """/sbin/reboot and /sbin/shutdown as /bin/true in run-local.sh's mount
    namespace, so a press that lands on the main menu's Reboot or Shutdown
    can't take the device down."""
    for tool in ("/sbin/reboot", "/sbin/shutdown"):
        if os.path.exists(tool):
            subprocess.run(["mount", "--bind", "/bin/true", tool], check=True)
    try:
        yield
    finally:
        for tool in ("/sbin/reboot", "/sbin/shutdown"):
            subprocess.run(["umount", tool], capture_output=True)


def everything(f):
    """All the text on the frame, at whatever rows it was drawn (a menu's
    rows are 10 pixels apart, so most aren't on an 8-pixel page)."""
    return "\n".join(t for t in (f.text_at(y) for y in range(57)) if t.strip("?"))


def in_main_menu(f):
    return "Tethering" in everything(f)


def test_answering_no_to_the_reset_prompt_goes_back_to_the_main_menu(oled_media, screen, no_reboot):
    """Main Menu > Reset > Perform Reset > "No" goes back to the main menu,
    fppoled still running. glibc is made to fill freed memory (tcache off,
    MALLOC_PERTURB_), so a use of the deleted Reset page shows.

    Regression: 5bd1a7c5d. The Reset page deletes itself once the prompt
    replaces it, and the prompt's callback captured the page: answering it
    read the page's parent (and, for "Yes", its items) from freed memory and
    crashed fppoled. "No" sends no reset request.
    """
    keys = buttons(oled_media, "Enter", "Down")
    with hosttools.pads_kept(keys.values()):
        screen.start(extra_env={"GLIBC_TUNABLES": "glibc.malloc.tcache_count=0",
                                "MALLOC_PERTURB_": "165"})
        wait_held(screen, *keys.values())
        for g in keys.values():
            pull(g, "pu")
        screen.wait_for(lambda f: f.line(0) in ("FPP Booting...", "No Network"), timeout=30,
                        what="the status page")
        press(keys["Enter"])
        screen.wait_for(in_main_menu, timeout=5, what="the main menu")
        # Down to Reset. The selected item is drawn inverted, which doesn't
        # read as text: Reset is selected when it is the one item missing
        # with Shutdown, the item above it, on the screen.
        for _ in range(10):
            t = everything(screen.frames()[-1])
            if "Shutdown" in t and "Reset" not in t:
                break
            press(keys["Down"])
        else:
            pytest.fail(f"never got to Reset; last frame:\n{everything(screen.frames()[-1])}")
        press(keys["Enter"])
        # the page's separator; its title is drawn inverted, and so is the
        # selected Perform Reset
        screen.wait_for(lambda f: "-------------" in everything(f), timeout=5, what="the Reset page")
        press(keys["Enter"])
        screen.wait_for(lambda f: "Reset FPP?" in everything(f), timeout=5, what="the reset prompt")
        shown = len(screen.frames())
        press(keys["Enter"])  # "No", the prompt's first answer
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(
                in_main_menu(f) for f in screen.frames()[shown:]):
            assert screen.proc.poll() is None, f"fppoled died answering No\n{screen.log()}"
            time.sleep(0.2)
        assert any(in_main_menu(f) for f in screen.frames()[shown:]), \
            f"no main menu after No; last frame:\n{everything(screen.frames()[-1])}\n{screen.log()}"
        assert screen.proc.poll() is None, screen.log()


def test_a_cape_button_whose_line_cannot_do_edges_is_polled(oled_media, screen):
    """A cape-inputs.json button (Enter, on the falling edge) on a line that
    refuses edge detection (gpiorefuse.c) is polled instead: one press
    opens the main menu.

    Regression: faf7d304c. When the edge request failed the button was set
    up as an edge input all the same, with no event file to wait on, so it
    never did anything. (gpio.json buttons, the other path, are
    test_oled_expander_buttons.py's polled case.)
    """
    (pin, gpio), = lines(1)
    oled_media.put("tmp/cape-inputs.json", json.dumps({"inputs": [
        {"pin": pin, "mode": "gpio_pu", "edge": "falling", "type": "Enter"}]}))
    with hosttools.pads_kept([gpio]):
        screen.start(preload=[shims.build("gpiorefuse.c")],
                     extra_env={"GPIOREFUSE": "edges", "GPIOREFUSE_LINE": str(gpio)})
        wait_held(screen, gpio)
        pull(gpio, "pu")
        screen.wait_for(lambda f: f.line(0) in ("FPP Booting...", "No Network"), timeout=30,
                        what="the status page")
        assert not any(main_menu(f) for f in screen.frames()), "the main menu opened unpressed"
        press(gpio)
        screen.wait_for(main_menu, timeout=5, what="the main menu after Enter")


def test_a_gpio_json_buttons_line_is_labelled_for_its_action(oled_media, screen):
    """fppoled names a gpio.json button's line after its action: gpioinfo
    consumer "FPPOLED-Up", as it does a cape-inputs.json or expander
    button's.

    Regression: 1556c5c6f. configureGPIOPin() passed "FPPOLED-<action>"
    as the description and configPin() put the process name in front again,
    so the line read FPPOLED-FPPOLED-Up (since bdc13ea2a). Also 809bd6a19
    (fppoled's half), which first labelled the buttons' lines; they were
    all just "FPPOLED".
    """
    keys = buttons(oled_media, "Up")
    with hosttools.pads_kept(keys.values()):
        screen.start()
        wait_held(screen, keys["Up"])
        from test_pi_gpio_inputs import line_info
        assert 'consumer="FPPOLED-Up"' in line_info(keys["Up"]), line_info(keys["Up"])
