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

import os
import signal
import subprocess
import threading
import time

import pytest

import cape_eeprom as ee
from fppinit import fppinit  # noqa: F401 -- the fixture

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
