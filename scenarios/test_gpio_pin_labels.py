"""How the web UI labels GPIO header pins, from fppd's own pin list.

Device only: run with run-local.sh on a BeagleBone (the container has no
header pins). The options API's PHP is run with php-cli in run-local.sh's
namespaces, against the test fppd's /gpio.
"""

import json
import os
import shutil
import subprocess

import pytest

PHP = r"""
chdir($argv[1] . '/www');
function json($data) { return json_encode($data); }
require_once 'common.php';
require_once 'api/controllers/options.php';
echo "\n@@GPIOS@@" . GetOptions_GPIOS(true);
"""


def gpio_options(fppd):
    if not shutil.which("php"):
        pytest.skip("no php-cli")
    r = subprocess.run(["php", "-d", "short_open_tag=1", "-r", PHP, "--", fppd.tree],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    return r.stdout


def test_beagle_gpio_options_are_bare_pin_names(fppd):
    """On a BeagleBone the GPIO dropdowns list bare header pin names: the
    gpiochip/line behind a pin comes from an asynchronous boot-time probe
    there and can change from one boot to the next.

    Regression: c44303b63. Every pin was labelled "P1-02 (GPIO 3/5)" off
    the Pi as on it. (The pixel-string port tooltip's "GPIOundefined" half
    of that commit is JavaScript and is not covered here.)
    """
    if not os.environ.get("FPP_TESTS_BEAGLE"):
        pytest.skip("needs a BeagleBone under run-local.sh")
    fppd.start(timeout=60)
    pins = fppd.get("/gpio")
    assert any(p.get("pin", "").startswith("P1-") for p in pins), pins[:5]
    out = gpio_options(fppd)
    # common.php and its includes print things of their own first
    assert "@@GPIOS@@" in out, out[-2000:]
    labels = json.loads(out.split("@@GPIOS@@", 1)[1])
    p1 = {k: v for k, v in labels.items() if k.startswith("P1-")}
    assert p1, labels
    assert all(k == v for k, v in p1.items()), {k: v for k, v in p1.items() if k != v}


FILTER_PHP = r"""
chdir($argv[1] . '/www');
function json($data) { return json_encode($data); }
require_once 'common.php';
require_once 'api/controllers/options.php';
$settings['showAllOptions'] = 0;
$settings['cape-info'] = json_decode($argv[2], true);
echo "\n@@GPIOS@@" . GetOptions_GPIOS(true);
"""


def filtered(fppd, cape_info):
    if not shutil.which("php"):
        pytest.skip("no php-cli")
    r = subprocess.run(["php", "-d", "short_open_tag=1", "-r", FILTER_PHP, "--", fppd.tree, json.dumps(cape_info)],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "@@GPIOS@@" in r.stdout, r.stdout[-2000:] + r.stderr[-2000:]
    return list(json.loads(r.stdout.split("@@GPIOS@@", 1)[1]))  # pin -> label


def test_the_gpio_lists_follow_the_capes_show_and_hide_filters(fppd):
    """The pins offered to the GPIO output and the GPIO command (the GPIOS
    and GPIOLIST options) are fppd's pin list less what the cape hides, and
    only what it shows when it shows some: patterns on the pin name, with
    "show all options" off.

    Feature: 423631bd2. The lists were every pin the machine has, however
    little of it a cape leaves free."""
    fppd.start()
    every = [p["pin"] for p in fppd.get("/gpio")]
    assert "TF-1" in every and "TF-2" in every, every
    assert filtered(fppd, {}) == every
    hidden = filtered(fppd, {"hide": {"gpio": ["^TF-1$"]}})
    assert "TF-1" not in hidden and "TF-2" in hidden, hidden
    only = filtered(fppd, {"show": {"gpio": ["^TF-2$"]}})
    assert only == ["TF-2"], only
