"""fppoled, the cape's status display and buttons: reading gpio.json, and
the cached cape logo it keeps outside the media directory.

fppoled isn't built in a container, so these run on a device under
run-local.sh. The gpio.json case runs fppoled with no display
(LEDDisplayType 0) in run-local.sh's namespaces, against its overlay of
/home/fpp/media (fppoled hardcodes that path), naming GPIO lines the
device's own fppoled already holds: fppoled finds the lines, its requests
for them fail, and nothing on the device changes. The logo cases run
fppoled and fppcapedetect in the fppinit sandbox, where /var/tmp is scratch.
"""

import json
import os
import signal
import subprocess
import threading
import time

import pytest

import cape_eeprom as ee
import hosttools
from fppinit import fppinit  # noqa: F401 -- the fixture
from test_gpio_pins import PLAIN_PINS, free_pins

MEDIA = "/home/fpp/media"


def media_is_an_overlay():
    try:
        with open("/proc/self/mountinfo") as f:
            return any(l.split()[4] == MEDIA and " - overlay " in l for l in f)
    except OSError:
        return False


def held_lines(*names):
    """Skip unless every named GPIO line exists and is already requested
    by something else (so fppoled can find it but not take it)."""
    try:
        out = subprocess.run(["gpioinfo"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        pytest.skip("no gpioinfo")
    for n in names:
        line = [l for l in out.splitlines() if f'"{n}"' in l]
        if not line or "consumer=" not in line[0]:
            pytest.skip(f"needs a GPIO line named {n} held by the device (a cape with OLED buttons)")


class OledMedia:
    """Files in run-local.sh's overlay of /home/fpp/media for one fppoled
    run, put back as they were afterwards."""

    def __init__(self):
        self.saved = {}

    def put(self, rel, content):
        path = os.path.join(MEDIA, rel)
        if path not in self.saved:
            self.saved[path] = open(path, "rb").read() if os.path.exists(path) else None
        if content is None:
            if os.path.exists(path):
                os.remove(path)
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)

    def settings(self, **kv):
        path = os.path.join(MEDIA, "settings")
        lines = open(path).read().splitlines() if os.path.exists(path) else []
        lines = [l for l in lines if l.split("=")[0].strip() not in kv]
        lines += [f'{k} = "{v}"' for k, v in kv.items()]
        self.put("settings", "\n".join(lines) + "\n")

    def restore(self):
        for path, data in self.saved.items():
            if data is None:
                if os.path.exists(path):
                    os.remove(path)
            else:
                with open(path, "wb") as f:
                    f.write(data)


@pytest.fixture
def oled_media():
    tree = os.environ.get("FPP_TREE", "")
    if not os.path.exists(os.path.join(tree, "src", "fppoled")):
        pytest.skip("no fppoled in the tree under test")
    if not media_is_an_overlay():
        pytest.skip("/home/fpp/media is not run-local.sh's overlay")
    m = OledMedia()
    m.settings(LEDDisplayType=0)
    m.put("tmp/cape_detect_done", "")
    # no I2C enable pin to drive, and no cape inputs unless a test gives some
    m.put("tmp/cape-info.json", None)
    m.put("tmp/cape-inputs.json", None)
    m.put("config/gpio.json", None)
    try:
        yield m
    finally:
        m.restore()


def run_fppoled(timeout=40):
    """Run fppoled; if it is still running after `timeout`, stop it with
    SIGTERM. Returns (exit status, output)."""
    src = os.path.join(os.environ["FPP_TREE"], "src")
    env = dict(os.environ, LD_LIBRARY_PATH=src)
    p = subprocess.Popen([os.path.join(src, "fppoled")], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, env=env)
    out = []
    reader = threading.Thread(target=lambda: out.extend(p.stdout), daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    while p.poll() is None and time.monotonic() < deadline:
        time.sleep(0.1)
    if p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
    reader.join(timeout=5)
    return p.returncode, "".join(out)


def test_fppoled_reads_the_fpp10_gpio_json(oled_media):
    """A gpio.json in FPP 10's form -- "rising"/"falling" an array of
    commands, possibly empty, one of them an OLED Navigation -- is read
    without fppoled aborting.

    Regression: fe372d4e1 (#2887). fppoled indexed the array with a string
    key, which throws Json::LogicError: fppoled aborted at startup and the
    display stayed dark.
    """
    held_lines("Up", "Down")
    oled_media.put("config/gpio.json", """[
  {"pin": "Up", "enabled": true, "mode": "gpio_pu", "desc": "",
   "rising": [], "falling": [{"command": "OLED Navigation", "args": ["Up"]}]},
  {"pin": "Down", "enabled": true, "mode": "gpio_pu", "desc": "",
   "rising": [{"command": "Volume Increase", "args": ["1"]}], "falling": []}
]""")
    rc, out = run_fppoled()
    assert "terminate called" not in out and "LogicError" not in out, out[-3000:]
    # nothing it could take (the lines are held) and no display: it exits 0
    assert rc == 0, f"fppoled exited {rc}:\n{out[-3000:]}"


# ---- the cached cape logo ------------------------------------------------------

CACHE = "/var/tmp/cape-image.xbm"
XBM = "#define cape_width 8\n#define cape_height 1\nstatic char cape_bits[] = { 0x55 };\n"


def oled_clear(sb):
    """fppoled's ExecStartPre pass, in the sandbox."""
    src = os.path.join(sb.tree, "src", "fppoled")
    if not os.path.exists(src):
        pytest.skip("no fppoled in the tree under test")
    sb.settings(LEDDisplayType=0)
    r = sb._run(["/opt/fpp/src/fppoled", "clear"], media_home=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return r


def test_fppoled_clear_drops_the_cached_logo_when_there_is_none(fppinit):
    """fppoled's "clear" pass copies media/tmp/cape-image.xbm to /var/tmp,
    and removes the /var/tmp copy when media/tmp has none.

    Regression: 94e34a68e. The pass only ever wrote the copy, so once an
    EEPROM stopped producing an image the display kept the old cape's logo
    on every later boot.
    """
    fppinit.root_file(CACHE, "stale logo\n")
    oled_clear(fppinit)
    assert fppinit.written(CACHE) is None, "the stale /var/tmp logo was kept"

    fppinit.write("tmp/cape-image.xbm", XBM)
    oled_clear(fppinit)
    assert fppinit.written(CACHE) == XBM


def test_fppoled_clear_removes_the_cape_detection_marker_and_exits(fppinit):
    """fppoled.service's ExecStartPre, `fppoled clear`, removes
    media/tmp/cape_detect_done (so the display waits for this boot's cape
    detection, not the last one's) and exits, without starting the
    display.

    Regression: dfba1d3d7. ExecStartPre was an `rm -rf`, which lost the
    race on a PocketBeagle2 whose filesystem was still read-only; the
    "clear" pass retries the unlink for up to 10 s. Without the pass,
    `fppoled clear` was the display daemon itself and never returned."""
    if not os.path.exists(os.path.join(fppinit.tree, "src", "fppoled")):
        pytest.skip("no fppoled in the tree under test")
    fppinit.settings(LEDDisplayType=0)
    fppinit.write("tmp/cape_detect_done", "")
    try:
        r = fppinit._run(["/opt/fpp/src/fppoled", "clear"], media_home=True, timeout=30)
    except subprocess.TimeoutExpired:
        pytest.fail("`fppoled clear` did not exit")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not fppinit.media_exists("tmp/cape_detect_done"), "the marker was left"


def test_fppinit_start_puts_back_a_marker_removed_while_it_ran(fppinit):
    """`fppinit start` writes media/tmp/cape_detect_done, the marker
    fppoled waits for before it configures the cape's buttons, once more
    when it has finished: fppoled.service starts alongside fppinit.service
    and its ExecStartPre removes the marker, so one written only at cape
    detection can be gone again by the time fppoled looks. A boot
    UserCallbackHook.sh, which fppinit runs after cape detection, removes
    it here as fppoled's ExecStartPre would. Needs only fppinit, so it runs
    in a container too.

    Regression: 1ae59d607. The marker was written once, at cape detection;
    on a slow Pi 3 fppoled's start removed it after that and the display
    waited out its timeout for a marker that never came back."""
    from test_fppinit import assert_clean
    hook = "scripts/UserCallbackHook.sh"
    fppinit.write(hook, '#!/bin/sh\n[ "$1" = boot ] && rm -f "$FPP_MEDIA_DIR/tmp/cape_detect_done"\n'
                        'echo "$1" >> "$0.ran"\n')
    os.chmod(os.path.join(fppinit.media, hook), 0o755)
    assert_clean(fppinit.run("start"))
    assert "boot" in (fppinit.media_file(hook + ".ran") if fppinit.media_exists(hook + ".ran") else ""), \
        "the boot hook never ran, so nothing removed the marker"
    assert fppinit.media_exists("tmp/cape_detect_done"), "fppinit start left no marker"


def test_cape_detection_keeps_the_cached_logo_in_step(fppinit):
    """A detect run whose EEPROM carries no image removes the /var/tmp copy
    of the logo; one that has an image refreshes it; a -ro run leaves it.

    Regression: 94e34a68e. Detection never touched the copy, so a re-detect
    after the EEPROM went blank still showed the previous cape's logo.
    """
    if not os.path.exists(os.path.join(fppinit.tree, "src", "fppcapedetect")):
        pytest.skip("no fppcapedetect in the tree under test")
    eeprom = "config/cape-eeprom.bin"
    fppinit.root_file(CACHE, "stale logo\n")

    fppinit.write_bytes(eeprom, ee.image(ee.cape_info()))
    r = fppinit.capedetect("-no-set-permissions", "-ro")
    assert r.returncode == 0, r.stdout + r.stderr
    assert fppinit.written(CACHE) == "stale logo\n", "a -ro run changed the cached logo"

    r = fppinit.capedetect("-no-set-permissions")
    assert r.returncode == 0, r.stdout + r.stderr
    assert fppinit.written(CACHE) is None, "the stale /var/tmp logo was kept"

    fppinit.write_bytes(eeprom, ee.image(ee.cape_info(), files={"cape-image.xbm": XBM}))
    r = fppinit.capedetect("-no-set-permissions")
    assert r.returncode == 0, r.stdout + r.stderr
    assert fppinit.written(CACHE) == XBM


# ---- what the display shows (oled.py's fake SSD1306) ----------------------------

@pytest.fixture
def screen(oled_media, tmp_path):
    """fppoled on a fake 128x64 SSD1306 (LEDDisplayType 1), stopped after the
    test; the frames it drew are read from screen.frames()."""
    import oled
    oled_media.settings(LEDDisplayType=1)
    s = oled.Fppoled(os.environ["FPP_TREE"], str(tmp_path))
    yield s
    if s.proc is not None:
        s.stop()


def lit(frame, x0, y0, w, h):
    return sum(frame.pixel(x, y) for x in range(x0, x0 + w) for y in range(y0, y0 + h))


def test_the_status_page_says_no_network_once_fppd_answers(screen, fppd):
    """With no network address but fppd running, the status page's top line
    reads "No Network" within a few seconds, and the lines below it are
    fppd's status.

    Regression: e323af2e9. The page said "FPP Booting..." for its first 60
    iterations whatever fppd said, so a box without a network looked stuck
    in boot for a minute. The test fppd is on the namespace's loopback,
    which the page doesn't count as a network.
    """
    fppd.settings(LEDDisplayType=1)
    fppd.start()
    screen.start()
    f = screen.wait_for(lambda f: f.line(0) == "No Network", timeout=15,
                        what='"No Network" on the top line')
    # under the separator (row 16), fppd's mode and status from its
    # /fppd/status, not the "Booting..." shown while fppd doesn't answer
    assert f.text_at(17) == "Player: idle", [f.text_at(y) for y in range(0, 57)]


def test_the_status_page_runs_once_a_second_with_buttons(oled_media, screen):
    """On a cape whose buttons are GPIO lines fppoled waits on for edges,
    the status page still redraws once a second.

    Regression: a52919427. Between iterations the run loop waited up to 5 s
    in poll() for a button, so on those capes every count the page keeps
    in iterations -- "FPP Booting..." for 60, the network rescan, the line
    rotation -- ran five times slow. The buttons here are free header lines
    (test_gpio_pins.free_pins); the test checks fppoled holds them, which is
    what puts it on the poll() path.
    """
    pins = free_pins()[:2]
    if len(pins) < 2:
        pytest.skip("needs two free plain header GPIOs (a Raspberry Pi)")
    gpios = [PLAIN_PINS[p] for p in pins]
    oled_media.put("config/gpio.json", json.dumps([
        {"pin": p, "enabled": True, "mode": "gpio_pu", "desc": "",
         "rising": [], "falling": [{"command": "OLED Navigation", "args": [b]}]}
        for p, b in zip(pins, ("Up", "Down"))]))
    with hosttools.pads_kept(gpios):
        try:
            screen.start()
            first = screen.wait_for(lambda f: True, timeout=30, what="a first frame")
            out = subprocess.run(["gpioinfo"], capture_output=True, text=True).stdout
            held = [l for l in out.splitlines()
                    if any(f'"GPIO{g}"' in l for g in gpios) and "FPPOLED" in l]
            assert len(held) == 2, f"fppoled does not hold {pins}:\n{out}\n{screen.log()}"
            time.sleep(8)
            frames = [f for f in screen.frames() if f.ms > first.ms]
            assert len(frames) >= 6, (f"{len(frames)} redraws in the 8 s after the first\n"
                                      f"{screen.log()}")
        finally:
            screen.stop()


def test_the_status_page_keeps_redrawing_after_the_clock_steps_back(screen, tmp_path):
    """After the wall clock steps back a day -- a never-set cape RTC taking
    over from the saved image time, about 10 s into a boot -- the status
    page goes on redrawing every second.

    Regression: a5e13f833. The run loop timed its 1 s refresh on the wall
    clock, so after a backward step "now" stayed behind the last update and
    the display froze on whatever it showed (on a box with no network,
    "Booting..." for good). fppoled's wall clock is libfaketime's here, its
    monotonic clock the real one.
    """
    import glob
    libs = glob.glob("/usr/lib/*/faketime/libfaketimeMT.so.1")
    if not libs:
        pytest.skip("libfaketime is not installed (apt-get install faketime)")
    clock = tmp_path / "faketime"
    clock.write_text("+0\n")
    screen.start(preload=[libs[0]], extra_env={
        "FAKETIME_TIMESTAMP_FILE": str(clock), "FAKETIME_NO_CACHE": "1",
        "FAKETIME_DONT_FAKE_MONOTONIC": "1", "NO_FAKE_STAT": "1"})
    screen.wait_for(lambda f: f.line(0) in ("FPP Booting...", "No Network"), timeout=30,
                    what="the status page")
    time.sleep(2)
    before = len(screen.frames())
    new = tmp_path / "faketime.new"
    new.write_text("-86400\n")
    os.replace(new, clock)
    stepped = time.monotonic()
    time.sleep(6)
    after = [f for f in screen.frames()[before:]]
    assert len(after) >= 4, (f"{len(after)} redraws in the 6 s after the clock stepped back "
                             f"a day\n{screen.log()}")
    assert screen.proc.poll() is None, screen.log()


def capeimage(oled_media, last):
    """An 8x8 cape image, every pixel lit (XBM bits are inverted on the
    panel), whose final token is `last`."""
    oled_media.put("tmp/cape-image.xbm",
                   "#define cape_width 8\n#define cape_height 8\n"
                   "static unsigned char cape_bits[] = {\n"
                   "   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, " + last + "\n")


def test_a_cape_image_whose_last_byte_shares_the_brace_is_drawn(oled_media, screen):
    """A cape image ending "0x00 };" (no comma before the brace, as the
    built-in PiHat and DPIPixels-24 images and the DIY templates are written)
    is drawn under the boot notice.

    Regression: 635bf758f. The parser dropped the token holding the brace,
    so the image came out a byte short of width x height and, since
    bb1d47557 checks that, was not drawn at all. Also 8e94aebf8, which put
    the boot stage ("FPP - Cape Detection") and the cape logo on the boot
    notice (red on a Pi 4 against master with the notice back to a plain
    "FPP Booting..." and no image).
    """
    capeimage(oled_media, "0x00 };")
    oled_media.put("tmp/cape_detect_done", None)
    screen.start()
    f = screen.wait_for(lambda f: f.line(0).startswith("FPP - Cape"), timeout=10,
                        what="the cape detection notice")
    assert lit(f, 0, 20, 8, 8) == 64, f.text()
    # nothing past the image's 8 columns: it is drawn where it belongs
    assert lit(f, 8, 20, 8, 8) == 0, f.text()


def test_a_cape_image_with_a_byte_that_is_not_hex_leaves_fppoled_running(oled_media, screen):
    """A cape image (it comes from the cape's EEPROM) with a token that isn't
    a hex byte is not drawn, and fppoled goes on to the status page.

    Regression: bb1d47557. The byte went to stoi, whose exception ended
    fppoled: no display at all for that cape.
    """
    oled_media.put("tmp/cape-image.xbm",
                   "#define cape_width 8\n#define cape_height 8\n"
                   "static unsigned char cape_bits[] = {\n"
                   "   0x00, 0x00, 0x00, zz, 0x00, 0x00, 0x00, 0x00, };\n")
    screen.start()
    f = screen.wait_for(lambda f: f.line(0) in ("FPP Booting...", "No Network"), timeout=30,
                        what="the status page")
    assert "terminate called" not in screen.log(), screen.log()
    # no image where the page puts one, under "Booting."
    assert lit(f, 0, 24, 8, 8) == 0, f.text()
    assert screen.stop() == 0, screen.log()
