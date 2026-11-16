"""BBE GPIO mapping without /sys/class/gpio or line names (#3189).

Every source-unit case omits legacy GPIO sysfs and supplies generic chip
labels and unnamed lines. The hardware case skips devices that do not have
those missing-metadata conditions. Neither case requests GPIO lines.
"""

import os
from pathlib import Path
import re
import shutil
import subprocess

import pytest


BANKS = ("44e07000", "4804c000", "481ac000", "481ae000")


@pytest.fixture(scope="module", params=("v1", "v2"))
def gpio_map_binary(request, tmp_path_factory):
    compiler = shutil.which("c++")
    if not compiler:
        pytest.skip("needs a C++23 compiler")
    tree = Path(os.environ["FPP_TREE"])
    source = (tree / "src/util/BBBUtils.cpp").read_text()
    function = "static void setupBBBMemoryMap()" + source.split(
        "static void setupBBBMemoryMap()", 1)[1].split("\n}\n", 1)[0] + "\n}\n"
    harness = Path(__file__).with_name("bbe_gpio_mapping.cpp").read_text()
    build = tmp_path_factory.mktemp("bbe-gpio-" + request.param)
    unit = build / "mapping.cpp"
    unit.write_text(harness.replace("static void setupBBBMemoryMap();", function))
    binary = build / "mapping"
    command = [compiler, "-std=c++23", "-DPLATFORM_BBB", str(unit), "-o", str(binary)]
    if request.param == "v2":
        command.append("-DIS_GPIOD_CXX_V2")
    compiled = subprocess.run(command, capture_output=True, text=True, timeout=60)
    assert compiled.returncode == 0, compiled.stdout + compiled.stderr
    return binary


def gpio_bus(root, mapping, expanders=()):
    bus = root / "sys/bus/gpio/devices"
    bus.mkdir(parents=True)
    for address, chip in zip(BANKS, mapping):
        target = root / "sys/devices/platform/ocp" / (address + ".gpio") / f"gpiochip{chip}"
        target.mkdir(parents=True)
        (bus / f"gpiochip{chip}").symlink_to(target)
    for n, chip in enumerate(expanders):
        target = root / "sys/devices/platform/i2c-2" / f"2-00{0x20 + n:02x}" / f"gpiochip{chip}"
        target.mkdir(parents=True)
        (bus / f"gpiochip{chip}").symlink_to(target)
    return bus


def discover(binary, root, count=4):
    assert not (root / "sys/class/gpio").exists()
    result = subprocess.run([str(binary), str(root), str(count)],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr
    return tuple(map(int, result.stdout.split()))


@pytest.mark.parametrize("mapping,expanders", [
    ((3, 0, 1, 2), ()),
    ((3, 0, 1, 2), (4, 5)),
    ((1, 3, 0, 2), ()),
    ((5, 2, 4, 1), (0, 3)),
    ((255, 0, 1, 2), ()),
])
def test_bbe_bank_discovery(gpio_map_binary, tmp_path, mapping, expanders):
    gpio_bus(tmp_path, mapping, expanders)
    count = max((*mapping, *expanders)) + 1
    assert discover(gpio_map_binary, tmp_path, count) == mapping


def test_missing_bus_leaves_mapping_unresolved(gpio_map_binary, tmp_path):
    assert discover(gpio_map_binary, tmp_path) == (0, 0, 0, 0)


def test_broken_bus_links_leave_mapping_unresolved(gpio_map_binary, tmp_path):
    bus = tmp_path / "sys/bus/gpio/devices"
    bus.mkdir(parents=True)
    (bus / "gpiochip0").symlink_to(tmp_path / "missing/44e07000.gpio/gpiochip0")
    assert discover(gpio_map_binary, tmp_path) == (0, 0, 0, 0)


def test_incomplete_bus_does_not_apply_partial_mapping(gpio_map_binary, tmp_path):
    bus = gpio_bus(tmp_path, (3, 0, 1, 2))
    (bus / "gpiochip2").unlink()
    assert discover(gpio_map_binary, tmp_path) == (0, 0, 0, 0)


@pytest.mark.parametrize("name", ["gpiochip", "gpiochip-1", "gpiochip256", "gpiochip1extra",
                                  "gpiochip999999999999999999999999999999"])
def test_invalid_chip_numbers_leave_mapping_unresolved(gpio_map_binary, tmp_path, name):
    bus = gpio_bus(tmp_path, (3, 0, 1, 2))
    target = (bus / "gpiochip3").resolve()
    (bus / "gpiochip3").unlink()
    (bus / name).symlink_to(target)
    assert discover(gpio_map_binary, tmp_path, count=257) == (0, 0, 0, 0)


def test_missing_character_device_leaves_mapping_unresolved(gpio_map_binary, tmp_path):
    gpio_bus(tmp_path, (4, 0, 1, 2))
    assert discover(gpio_map_binary, tmp_path, count=4) == (0, 0, 0, 0)


def test_bbe_runtime_gpio_mapping(fppd):
    """Hardware-only: BBE without legacy GPIO sysfs or line names.

    Regression: 3083345bf (#3189). Generic chip labels, unnamed lines and no legacy GPIO
    sysfs leave every bank mapped to chip0.
    """
    if not os.environ.get("FPP_TESTS_BEAGLE"):
        pytest.skip("needs a BBE under run-local.sh")
    model = Path("/proc/device-tree/model").read_bytes().rstrip(b"\0").decode()
    if model != "SanCloud BeagleBone Enhanced":
        pytest.skip("needs a SanCloud BBE")
    if Path("/sys/class/gpio").exists():
        pytest.skip("needs /sys/class/gpio to be absent")
    mapping = {}
    for device in Path("/sys/bus/gpio/devices").glob("gpiochip*"):
        for bank, address in enumerate(BANKS):
            if address + ".gpio" in device.resolve().parts:
                mapping[bank] = int(device.name.removeprefix("gpiochip"))
    if len(mapping) != 4:
        pytest.skip("needs four AM335x bank paths")
    if not shutil.which("gpioinfo"):
        pytest.skip("needs gpioinfo to verify missing line names")
    info = subprocess.run(["gpioinfo"], capture_output=True, text=True, timeout=10)
    assert info.returncode == 0, info.stderr
    sections = re.split(r"(?m)^(gpiochip\d+) - \d+ lines:\n", info.stdout)
    chips = dict(zip(sections[1::2], sections[2::2]))
    for chip in mapping.values():
        names = re.findall(r"(?m)^\s*line\s+\d+:\s+(\S+)", chips.get(f"gpiochip{chip}", ""))
        if len(names) != 32 or any(name != "unnamed" for name in names):
            pytest.skip("needs all four SoC GPIO banks to have unnamed lines")
    fppd.start(timeout=60)
    pins = {pin["pin"]: pin for pin in fppd.get("/gpio")}
    for pin, bank, offset in (("P9-11", 0, 30), ("P8-03", 1, 6),
                              ("P8-07", 2, 2), ("P9-25", 3, 21),
                              ("P8-27", 2, 22), ("P8-30", 2, 25),
                              ("P8-29", 2, 23), ("P9-26", 0, 14)):
        assert (pins[pin]["gpioChip"], pins[pin]["gpioLine"]) == (mapping[bank], offset), pins[pin]
