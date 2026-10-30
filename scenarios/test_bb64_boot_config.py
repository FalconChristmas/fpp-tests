"""A PocketBeagle2's boot configuration from the tree under test: the base
device tree overlay (capes/drivers/bb64/fpp-base-overlay.dts) and
extlinux.conf, checked the way the board uses them.

The overlay is compiled as its Makefile does (cpp and dtc against the
image's /opt/source/dtb-* headers) and applied with fdtoverlay to the
board's own base tree -- the one u-boot booted, /proc/device-tree/chosen
/base_dtb -- and so is the cape overlay installed beside it, as u-boot's
fdtoverlays line applies both. Each node a scenario checks must then read
the same in the running kernel's /proc/device-tree, and where the node
makes or stops a device, the device must be there or not (an RTC, a
remote processor, a PWM chip, the TEE). Nothing in /boot is changed.

Device only: run-local.sh on a PocketBeagle2 (needs dtc, fdtoverlay and
the image's device tree headers). Skipped elsewhere.
"""

import glob
import os
import re
import subprocess

import pytest

DT = "/proc/device-tree"
BOOT = "/boot/firmware"


def on_pb2():
    try:
        with open(f"{DT}/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not on_pb2(), reason="needs a PocketBeagle2")


def tree():
    t = os.environ.get("FPP_TREE")
    if not t:
        pytest.skip("no FPP_TREE")
    return t


def run(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, f"{' '.join(cmd)}: {r.stdout}{r.stderr}"
    return r.stdout


def base_dtb():
    with open(f"{DT}/chosen/base_dtb") as f:
        name = f.read().strip("\0\n").replace(".dts", ".dtb")
    path = os.path.join(BOOT, "ti", name)
    if not os.path.exists(path):
        pytest.skip(f"the booted base tree {path} is not there")
    return path


@pytest.fixture(scope="module")
def trees(tmp_path_factory):
    """(the base tree with the tree's base overlay, the same with the
    installed cape overlay as well -- what the board booted)."""
    for tool in ("cpp", "dtc", "fdtoverlay", "fdtget"):
        if subprocess.run(["which", tool], capture_output=True).returncode:
            pytest.skip(f"no {tool}")
    src = os.path.join(tree(), "capes", "drivers", "bb64")
    with open(os.path.join(src, "Makefile")) as f:
        m = re.search(r"^DTD_BASE\s*:?=\s*(\S+)", f.read(), re.M)
    dtd = m.group(1) if m else ""
    if not os.path.isdir(dtd):
        pytest.skip(f"no device tree headers at {dtd!r}")
    out = tmp_path_factory.mktemp("dtb")
    pre = out / "base.dts"
    with open(pre, "w") as f:
        f.write(run("cpp", f"-I{dtd}/include/", f"-I{dtd}/src/arm64/ti/", "-nostdinc", "-undef",
                    "-x", "assembler-with-cpp", os.path.join(src, "fpp-base-overlay.dts")))
    overlay = out / "fpp-base-overlay.dtb"
    run("dtc", "-q", "--include", f"{dtd}/include/", "--include", f"{dtd}/src/arm64/ti/",
        "-O", "dtb", "-o", str(overlay), str(pre))
    base = out / "base.dtb"
    run("fdtoverlay", "-i", base_dtb(), "-o", str(base), str(overlay))
    booted = out / "booted.dtb"
    cape = os.path.join(BOOT, "overlays", "fpp-cape-overlay.dtb")
    run("fdtoverlay", "-i", base_dtb(), "-o", str(booted), str(overlay), cape)
    return str(base), str(booted)


def path_of(dtb, label):
    return run("fdtget", "-t", "s", dtb, "/__symbols__", label).strip()


def prop(dtb, node, name):
    r = subprocess.run(["fdtget", "-t", "s", dtb, node, name], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def live(node, name):
    try:
        with open(f"{DT}{node}/{name}", "rb") as f:
            return f.read().rstrip(b"\0").decode(errors="replace")
    except FileNotFoundError:
        return None


def status(dtb, label):
    node = path_of(dtb, label)
    return prop(dtb, node, "status") or "okay"


def check(trees, expect):
    """Each {label: status} as the base overlay sets it, and the running
    kernel's node as the booted tree (cape overlay too) has it."""
    base, booted = trees
    got = {l: status(base, l) for l in expect}
    assert got == expect, f"the base overlay sets {got}, wanted {expect}"
    for label in expect:
        node = path_of(booted, label)
        assert (live(node, "status") or "okay") == (prop(booted, node, "status") or "okay"), \
            f"{label} ({node}) reads {live(node, 'status')!r} in the running kernel"


def device_names(pattern):
    out = []
    for p in glob.glob(pattern):
        try:
            out.append(os.path.basename(os.path.realpath(p)) + " " + open(os.path.join(p, "name")).read().strip())
        except OSError:
            out.append(os.path.realpath(p))
    return out


def test_the_internal_rtc_is_not_used(trees):
    """The AM62x's own RTC (wkup_rtc0) has no battery, so it is disabled:
    no rtc-ti-k3 clock registers, and a cape's battery-backed RTC is the
    one fpprtc sets the time from.

    Regression: b5d6529b0 (the RTC half)."""
    check(trees, {"wkup_rtc0": "disabled"})
    assert not [n for n in device_names("/sys/class/rtc/rtc*") if "rtc-ti-k3" in n], \
        device_names("/sys/class/rtc/rtc*")


def test_spi0_and_the_ecaps_leave_their_pins_alone_and_the_epwms_are_up(trees):
    """SPI0 and eCAP0-2 are disabled with no pinctrl of their own, so their
    pins stay free for the cape; the ePWMs are enabled with no pinctrl
    (pinctrl muxes a pin to one when a cape asks), so each is a PWM chip.

    Regression: b5d6529b0 (the pins half)."""
    check(trees, {"main_spi0": "disabled", "ecap0": "disabled", "ecap1": "disabled",
                  "ecap2": "disabled", "epwm0": "okay", "epwm1": "okay", "epwm2": "okay"})
    base, _ = trees
    for label in ("main_spi0", "ecap0", "epwm0", "main_uart0"):
        assert prop(base, path_of(base, label), "pinctrl-0") == "", f"{label} still claims pins"
    chips = [os.path.realpath(p) for p in glob.glob("/sys/class/pwm/pwmchip*")]
    for addr in ("23000000", "23010000", "23020000"):
        assert any(f"/{addr}.pwm/" in c for c in chips), f"no PWM chip for {addr}: {chips}"


def test_the_unused_cores_are_off(trees):
    """The GPU, the M4F and the wakeup R5F are disabled, and OP-TEE, to
    give their memory back: no remote processor but the PRUs, no GPU, no
    /dev/tee0.

    Regression: bf120277b (GPU), 70cdf66a3 (OP-TEE and the M4F),
    3845587e7 (the R5F)."""
    check(trees, {"gpu": "disabled", "mcu_m4fss": "disabled", "wkup_r5fss0": "disabled",
                  "wkup_r5fss0_core0": "disabled"})
    base, _ = trees
    assert prop(base, "/firmware/optee", "status") == "disabled"
    assert live("/firmware/optee", "status") == "disabled"
    procs = [os.path.basename(os.path.realpath(p)) for p in glob.glob("/sys/class/remoteproc/*")]
    procs = [open(f"/sys/class/remoteproc/{p}/name").read().strip() if os.path.exists(f"/sys/class/remoteproc/{p}/name") else p
             for p in os.listdir("/sys/class/remoteproc")]
    assert all(p.endswith(".pru") for p in procs), procs
    assert not os.path.exists("/dev/tee0") and not os.path.exists("/dev/dri"), "a TEE or GPU device is up"


def test_uart1_is_off_and_the_others_on(trees):
    """UART1 (four pins most capes use for something else) is disabled by
    the base overlay; UART0 and UART2-5 are enabled. A cape that wants
    UART1 enables it in its own overlay, and the running kernel has what
    the two overlays together say.

    Regression: 3845587e7 (UART1), ba6efd2a0 (the overlay half: UART2-5
    on)."""
    check(trees, {"main_uart0": "okay", "main_uart1": "disabled", "main_uart2": "okay",
                  "main_uart3": "okay", "main_uart4": "okay", "main_uart5": "okay"})


def test_the_pixel_buffer_memory_is_reserved_and_the_overlay_named(trees):
    """4 MB at 0x8f000000 is reserved for the PRU pixel buffers, and the
    overlay registers itself in /chosen/overlays as FPP_BASE_OVERLAY, both
    in the running kernel.

    Regression: b65352476 (reserved through &reserved_memory, named in
    /chosen), 70cdf66a3 (the name)."""
    base, _ = trees
    node = "/reserved-memory/fpp_reserved@8f000000"
    reg = run("fdtget", "-t", "x", base, node, "reg").split()
    assert [int(x, 16) for x in reg] == [0, 0x8F000000, 0, 0x400000], reg
    with open(f"{DT}{node}/reg", "rb") as f:
        assert f.read() == bytes.fromhex("00000000 8f000000 00000000 00400000".replace(" ", ""))
    assert prop(base, "/chosen/overlays", "fpp-base-overlay") == "FPP_BASE_OVERLAY"
    assert live("/chosen/overlays", "fpp-base-overlay") == "FPP_BASE_OVERLAY"


def test_a_cape_can_turn_on_audio_with_a_status_change(trees):
    """McASP2 is configured for I2S with its pins, and a simple-audio-card
    "sound" node points at it, both disabled: a cape's overlay only has to
    set them okay (and name its codec) for a sound card to appear.

    Feature: 7f1a8db5c. On a cape whose overlay does that, the running
    kernel has the sound card."""
    base, booted = trees
    mcasp = path_of(base, "mcasp2")
    assert prop(base, mcasp, "status") == "disabled"
    assert prop(base, mcasp, "pinctrl-names") == "default"
    assert run("fdtget", base, mcasp, "serial-dir").split() == ["1", "0"]
    assert prop(base, "/sound", "compatible") == "simple-audio-card"
    assert prop(base, "/sound", "status") == "disabled"
    cpu = run("fdtget", base, "/sound/simple-audio-card,cpu", "sound-dai").split()
    assert int(cpu[0]) == int(run("fdtget", base, mcasp, "phandle").split()[0]), cpu
    if prop(booted, "/sound", "status") == "okay":
        assert live("/sound", "status") == "okay"
        with open("/proc/asound/cards") as f:
            assert "simple-card" in f.read(), "the cape's overlay enabled audio but no card appeared"


# extlinux.conf


def labels():
    with open(os.path.join(tree(), "capes", "drivers", "bb64", "extlinux", "extlinux.conf")) as f:
        text = f.read()
    out, cur = {}, None
    for line in text.splitlines():
        words = line.split(None, 1)
        if not words:
            continue
        key = words[0].lower()
        if key == "label":
            cur = out.setdefault(words[1].strip(), {})
        elif key == "default":
            out["__default__"] = words[1].strip()
        elif cur is not None and len(words) == 2:
            cur[key] = words[1].strip()
    return out


def args(label):
    return dict(a.split("=", 1) if "=" in a else (a, "") for a in label["append"].split())


def running_args():
    with open("/proc/cmdline") as f:
        return f.read().split()


def on_this_disk(dev):
    """The tree's entries are written for a microSD card (mmcblk1); the
    eMMC flasher rewrites them for the eMMC (mmcblk0). The same partition on
    the disk this board booted from."""
    disk = re.match(r"/dev/(mmcblk\d+)p\d+$", dict(a.split("=", 1) for a in running_args() if "=" in a)["root"])
    return re.sub(r"^/dev/mmcblk\d+(?=p\d+$)", f"/dev/{disk.group(1)}", dev) if disk else dev


def test_every_extlinux_entry_boots_a_kernel_and_disks_that_are_there():
    """Each extlinux.conf entry names a kernel that is in /boot/firmware
    and root= and resume= partitions that exist (on the disk the board
    booted from), the safe entry included; and the default entry is the
    one the board booted: every argument it gives is on the running
    kernel's command line.

    Regression: 82ca8b729 and 75069d7a6 (the safe entry's resume= was
    cut off, then "/de/mmcblk1p2"), e5d2e9915 (the default boots
    Image.gz, the kernel the image ships), f0b86ca90 (cryptomgr.notests=1:
    no crypto self tests at boot), 28f8796f5 (console=ttyS2 for the
    serial console)."""
    ls = labels()
    default = ls[ls.pop("__default__")]
    for name, l in ls.items():
        kernel = os.path.join(BOOT, l["kernel"].lstrip("/"))
        assert os.path.exists(kernel), f"{name}: no kernel {kernel}"
        a = args(l)
        for key in ("root", "resume"):
            if key in a:
                assert os.path.exists(on_this_disk(a[key])), f"{name}: {key}={a[key]} is not a partition here"
    running = running_args()
    want = [on_this_disk(w.split("=", 1)[1]) and w.split("=", 1)[0] + "=" + on_this_disk(w.split("=", 1)[1])
            if w.startswith(("root=", "resume=")) else w for w in default["append"].split()]
    missing = [w for w in want if w not in running]
    assert not missing, f"the default entry gives {missing}, not on the running command line {running}"
    assert "cryptomgr.notests=1" in want and "console=ttyS2,115200n8" in want, want


def test_the_safe_entry_boots_without_any_overlay():
    """extlinux.conf has a safe entry that boots the same root without
    fdtoverlays, so a cape overlay that stops the board booting can be
    got round at the console and fixed; the default entry loads the base
    and cape overlays, which are in /boot/firmware/overlays.

    Feature: b4b08763c; 6791edad4 (the cape overlay slot)."""
    ls = labels()
    default = ls[ls.pop("__default__")]
    safe = [l for n, l in ls.items() if "safe" in n.lower()]
    assert safe, list(ls)
    assert "fdtoverlays" not in safe[0], safe[0]
    assert args(safe[0])["root"] == args(default)["root"]
    assert args(safe[0])["resume"] == args(default)["resume"]
    loads = default["fdtoverlays"].split()
    assert [os.path.basename(o) for o in loads] == ["fpp-base-overlay.dtb", "fpp-cape-overlay.dtb"], loads
    for o in loads:
        assert os.path.exists(os.path.join(BOOT, o.lstrip("/"))), o
