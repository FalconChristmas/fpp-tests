"""A cape EEPROM on the i2c bus, for fppcapedetect in the fppinit sandbox.

fppcapedetect only counts a cape as read from a chip (the SIGNED status, the
type-98 "physical" location a signed image asks for, removeSettings and
licensing) when it found the image at /sys/bus/i2c/devices/<bus>-0050/eeprom:
the same bytes as a virtual config/cape-eeprom.bin are treated as a plain
file. The sandbox has no bus, so this presents one the way
test_dpi_smart_receivers.signed_cape_env does for fppd: fakesys.so serves the
bus's sysfs entries from the media directory, and a stub i2cdetect answers
for the cape's address.

    argv = i2c_cape.present(sandbox, image)
    sandbox._run(argv + ["/opt/fpp/src/fppcapedetect", "-no-set-permissions"], media_home=True)

Everything it puts down is under the sandbox's media/i2c-cape (not media/tmp,
which cape detection clears), seen by the run at /home/fpp/media/i2c-cape.
"""

import os
import shutil

import shims

BUSES = (0, 1, 2)  # the bus fppcapedetect probes: 0 in a container build, 1 on a Pi, 2 on a Beagle
MEDIA = "/home/fpp/media"


def present(sb, image, buses=BUSES):
    """Install `image` as the EEPROM at 0x50 of each bus in `buses` and
    return the `env ...` argv prefix that makes a command see it."""
    # a 24c256 is 32 KiB, erased bytes 0xFF; the copy fppcapedetect makes of it
    # reads to the end of a chip and does not stop at the end of a short file
    image = image.ljust(32768, b"\xff")
    root = os.path.join(sb.media, "i2c-cape")
    shutil.rmtree(root, ignore_errors=True)
    maps = []
    for bus in buses:
        chip = os.path.join(root, f"{bus}-0050")
        os.makedirs(chip)
        with open(os.path.join(chip, "eeprom"), "wb") as f:
            f.write(image)
        adapter = os.path.join(root, f"i2c-{bus}")
        os.makedirs(adapter)
        for name in ("new_device", "delete_device"):
            open(os.path.join(adapter, name), "w").close()
        maps.append(f"/sys/bus/i2c/devices/{bus}-0050={MEDIA}/i2c-cape/{bus}-0050")
        maps.append(f"/sys/bus/i2c/devices/i2c-{bus}={MEDIA}/i2c-cape/i2c-{bus}")
    bindir = os.path.join(root, "bin")
    os.makedirs(bindir)
    with open(os.path.join(bindir, "i2cdetect"), "w") as f:
        f.write("#!/bin/sh\necho '50: 50'\n")
    os.chmod(os.path.join(bindir, "i2cdetect"), 0o755)
    so = os.path.join(root, "fakesys.so")
    shutil.copy(shims.build("fakesys.c"), so)
    return ["env", f"LD_PRELOAD={MEDIA}/i2c-cape/fakesys.so", "FAKESYS=" + ":".join(maps),
            f"PATH={MEDIA}/i2c-cape/bin:" + os.environ.get("PATH", "/usr/bin:/bin")]
