"""fppoled's pages on a fake SSD1306 (oled.py): the H-flipped display types,
the boot notice's cape logo cached from the last boot, scrolling the sensors
page, and backing out of the Reset prompt.

The buttons are gpio.json OLED Navigation inputs on free Raspberry Pi header
lines, pressed by flipping their pads' pulls with the real pinctrl (as in
test_oled_expander_buttons.py).

Device only: run-local.sh on a Pi (fppoled isn't built in a container).
"""

import http.server
import json
import os
import subprocess
import threading
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


@pytest.fixture
def web_stand_in():
    """A stand-in for the player's web server on 127.0.0.1:80, which is where
    fppoled sends its menu actions: records (method, path) of each request
    and answers 200 "{}" ."""
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def handle_any(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n).decode() if n else ""
            seen.append((self.command, self.path, body))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        do_GET = do_POST = do_PUT = do_DELETE = handle_any

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 80), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield seen
    finally:
        server.shutdown()
        server.server_close()


def open_main_menu(screen, keys):
    screen.wait_for(lambda f: f.line(0) in ("FPP Booting...", "No Network"), timeout=30,
                    what="the status page")
    press(keys["Enter"])
    screen.wait_for(in_main_menu, timeout=5, what="the main menu")


def down_to_reset_page(screen, keys):
    """From the main menu to the Reset page: Reset is selected when it is the
    one item missing with Shutdown, the item above it, on the screen."""
    for _ in range(10):
        t = everything(screen.frames()[-1])
        if "Shutdown" in t and "Reset" not in t:
            break
        press(keys["Down"])
    else:
        pytest.fail(f"never got to Reset; last frame:\n{everything(screen.frames()[-1])}")
    press(keys["Enter"])
    screen.wait_for(lambda f: "-------------" in everything(f), timeout=5, what="the Reset page")


def test_resetting_the_ticked_areas_asks_the_web_server_for_just_those(oled_media, screen, no_reboot,
                                                                      web_stand_in):
    """Main Menu > Reset: ticking Networking and Schedule and answering Yes to
    Perform Reset asks the web server to reset those two areas, in list
    order, and nothing else.

    Regression: 8378421c3 (the Reset menu). Pressing Perform Reset with no
    area ticked asks for nothing.
    """
    keys = buttons(oled_media, "Enter", "Down", "Up")
    with hosttools.pads_kept(keys.values()):
        screen.start()
        wait_held(screen, *keys.values())
        for g in keys.values():
            pull(g, "pu")
        open_main_menu(screen, keys)
        down_to_reset_page(screen, keys)
        # Perform Reset, Back, the separator, All, then Networking
        for _ in range(4):
            press(keys["Down"])
        press(keys["Enter"])
        for _ in range(7):  # ... Configuration, Outputs, Settings, Sequences, Media, Playlists, Schedule
            press(keys["Down"])
        press(keys["Enter"])
        for _ in range(11):
            press(keys["Up"])
        press(keys["Enter"])  # Perform Reset
        screen.wait_for(lambda f: "Reset FPP?" in everything(f), timeout=5, what="the reset prompt")
        press(keys["Down"])
        press(keys["Enter"])  # Yes
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not [r for r in web_stand_in if "resetConfig" in r[1]]:
            time.sleep(0.2)
        got = [r for r in web_stand_in if "resetConfig" in r[1]]
        assert [r[1] for r in got] == ["/resetConfig.php?areas=networking,schedule"], \
            (web_stand_in, everything(screen.frames()[-1]), screen.log())


def test_choosing_remote_in_the_fpp_mode_menu_sets_the_mode_and_restarts_fppd(oled_media, screen, no_reboot,
                                                                              web_stand_in):
    """Main Menu > FPP Mode > Remote sets the fppMode setting to "remote"
    through the settings API and restarts fppd, and asks for nothing else of
    the web server.

    Regression: 54ece1ff8, which moved this menu off the fppxml and fppjson
    helpers onto /api/settings and /api/system/fppd/restart.
    """
    keys = buttons(oled_media, "Enter", "Down", "Up")
    with hosttools.pads_kept(keys.values()):
        screen.start()
        wait_held(screen, *keys.values())
        for g in keys.values():
            pull(g, "pu")
        open_main_menu(screen, keys)
        press(keys["Down"])  # Start Playlist, then FPP Mode
        press(keys["Enter"])
        screen.wait_for(lambda f: "Back" in everything(f) and not in_main_menu(f), timeout=5,
                        what="the FPP Mode menu (Player, Remote, Back)")
        press(keys["Down"])  # Remote
        press(keys["Enter"])
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not any("restart" in r[1] for r in web_stand_in):
            time.sleep(0.2)
        assert ("PUT", "/api/settings/fppMode", "remote") in web_stand_in, \
            (web_stand_in, everything(screen.frames()[-1]))
        assert ("POST", "/api/system/fppd/restart", "") in web_stand_in, web_stand_in


def test_the_testing_menu_starts_and_stops_a_test_through_the_command_api(oled_media, screen, no_reboot,
                                                                         web_stand_in):
    """Main Menu > Testing > White asks the web server's command API for a
    Test Start of the single colour #ffffff (the menu's test speed first),
    not multisync, and Off then sends Test Stop.

    Regression: 615e0f9be (fppoled starts and stops tests with FPP
    commands), fd45611b8 (the Test action starting nothing).
    """
    keys = buttons(oled_media, "Enter", "Down", "Up")
    with hosttools.pads_kept(keys.values()):
        screen.start()
        wait_held(screen, *keys.values())
        for g in keys.values():
            pull(g, "pu")
        open_main_menu(screen, keys)
        for _ in range(3):  # Start Playlist, FPP Mode, Tethering, then Testing
            press(keys["Down"])
        press(keys["Enter"])
        screen.wait_for(lambda f: "White" in everything(f) or "Cycle" in everything(f), timeout=5,
                        what="the Testing menu")
        for _ in range(2):  # Enable Multisync, Off, then White
            press(keys["Down"])
        press(keys["Enter"])
        press(keys["Up"])  # Off
        press(keys["Enter"])

        def commands():
            return [json.loads(b) for m, p, b in web_stand_in if p == "/api/command" and b]

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and len(commands()) < 2:
            time.sleep(0.2)
        start, stop = (commands() + [{}, {}])[:2]
        assert start.get("command") == "Test Start" and start["args"][1:] == ["RGB Single Color", "", "#ffffff"], \
            (web_stand_in, everything(screen.frames()[-1]))
        assert start.get("multisyncCommand") is False, start
        assert stop.get("command") == "Test Stop", (stop, web_stand_in)


def test_a_gpio_json_button_overrides_the_capes_button_on_the_same_pin(oled_media, screen):
    """A pin named in both gpio.json (Enter) and the cape's cape-inputs.json
    (Up) acts as the gpio.json one: a press opens the main menu, which Up on
    the status page would not.

    Regression: 4f1e13cc2. The cape's inputs were read first, so the cape's
    action held the pin and the user's own gpio.json choice was skipped.
    """
    (pin, gpio), = lines(1)
    oled_media.put("config/gpio.json", json.dumps([
        {"pin": pin, "enabled": True, "mode": "gpio_pu", "rising": [], "falling": nav("Enter")}]))
    oled_media.put("tmp/cape-inputs.json", json.dumps({"inputs": [
        {"pin": pin, "mode": "gpio_pu", "edge": "falling", "type": "Up"}]}))
    with hosttools.pads_kept([gpio]):
        screen.start()
        wait_held(screen, gpio)
        pull(gpio, "pu")
        screen.wait_for(lambda f: f.line(0) in ("FPP Booting...", "No Network"), timeout=30,
                        what="the status page")
        press(gpio)
        screen.wait_for(in_main_menu, timeout=5, what="the main menu from gpio.json's Enter")


def test_the_status_page_shows_the_wifi_qr_screen_while_its_image_exists(oled_media, screen):
    """With a Wi-Fi QR image in media/tmp (wifi-L.ascii, '#' for a dark
    module, two characters to a module) the status page, after its first
    15 refreshes, alternates to a screen with the image and "WiFi Hot Spot"
    beside it, and goes back to the status text once the file is gone.

    Regression: ba9c6d3f5 (the QR screen), 2a233c99d (it comes down when
    tethering is disabled and the image removed).
    """
    modules = 21
    art = "\n".join("".join(("##" if (x + y) % 2 else "  ") for x in range(modules))
                    for y in range(modules)) + "\n"
    oled_media.put("tmp/wifi-L.ascii", art)

    def qr_screen(f):
        # the QR bitmap's rows are dark/light modules, which the text decoder
        # reads as nothing: no status line is legible and the glass is lit
        return not everything(f).strip() and sum(1 for b in f.data if b) > 100

    screen.start()
    screen.wait_for(qr_screen, timeout=60, what="the Wi-Fi QR screen")
    os.remove("/home/fpp/media/tmp/wifi-L.ascii")
    mark = len(screen.frames())
    screen.wait_for(lambda f: f.ms > screen.frames()[mark - 1].ms and f.line(0) in ("FPP Booting...", "No Network"), timeout=40,
                    what="the status text back once the image is gone")
    # 30 refreshes cover a whole alternation: nothing after that is the QR screen
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline and len(screen.frames()) < mark + 32:
        time.sleep(0.5)
    later = screen.frames()[mark + 2:]
    assert later and not any(qr_screen(f) for f in later), \
        f"the QR screen came back after its image was removed: {len(later)} frames"
