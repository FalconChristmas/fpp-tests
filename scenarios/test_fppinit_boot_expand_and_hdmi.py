"""Boot-time root partition expansion and HDMI audio card handling in the
fppinit sandbox (fppinit.py).

The partition tests give fppinit an SD card (/dev/mmcblk0, an empty file:
only its presence is checked) and stand-ins for the tools it asks about
the card -- findmnt, parted and sfdisk answer as they would for a freshly
flashed two-partition image, and fdisk records the commands it is fed.
The audio tests reuse test_audio_boot_cards.py's faked sound cards, with
/sys/class/drm faked as well for the HDMI connectors' status.
"""

import json
import os

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_audio_boot_cards import fake_boards, setup_audio
from test_fppinit_audio_cards import set_setting
from test_fppinit_boot_config import start

# parted -ms unit s p for a freshly flashed image on a 32GB card: a boot
# partition and a root partition that ends long before the card does.
PARTED = ("BYT;\n"
          "/dev/mmcblk0:62333952s:sd/mmc:512:512:msdos:SD Card:;\n"
          "1:8192s:1056767s:1048576s:fat32::lba;\n"
          "2:1056768s:7340031s:6283264s:ext4::;\n")

SFDISK_FREE = ("Unpartitioned space /dev/mmcblk0: 26.22 GiB, 28159459328 bytes, 54993921 sectors\n"
               "Units: sectors of 1 * 512 = 512 bytes\n"
               "Sector size (logical/physical): 512 bytes / 512 bytes\n\n"
               "   Start      End  Sectors  Size\n"
               "7340032 62333951 54993920 26.2G\n")


def sd_card(sb, root="/dev/mmcblk0p2", marker=True, sfdisk=SFDISK_FREE):
    """An SD card with free space after its root partition, the root
    filesystem on `root`, and (if `marker`) the image's first-boot
    fpp_expand_rootfs marker in the boot partition."""
    sb.root_file("/dev/mmcblk0", "")
    sb.root_file("/etc/fpp/desktop", None)
    sb.root_file("/usr/bin/findmnt",
                 "#!/bin/sh\n"
                 "echo \"findmnt $*\" >> /fppinit-calls.log\n"
                 "for a; do last=$a; done\n"
                 f"[ \"$last\" = / ] && echo {root}\n"
                 "exit 0\n")
    sb.root_file("/usr/sbin/parted",
                 "#!/bin/sh\n"
                 "echo \"parted $*\" >> /fppinit-calls.log\n"
                 f"printf '%s' '{PARTED}'\n")
    sb.stub_output("sfdisk", "-F", sfdisk)
    sb.root_file("/usr/sbin/sfdisk", "#!/bin/sh\ncat /fppinit-state/sfdisk.-F.out\n")
    # what fdisk is fed goes where written() can read it; fppinit removes
    # the /tmp file it fed it from
    sb.root_file("/usr/sbin/fdisk",
                 "#!/bin/sh\necho \"fdisk $*\" >> /fppinit-calls.log\ncat > /fdisk-input\n")
    sb.root_file("/usr/sbin/resize2fs", "#!/bin/sh\necho \"resize2fs $*\" >> /fppinit-calls.log\n")
    if marker:
        with open(os.path.join(sb.boot, "fpp_expand_rootfs"), "w") as f:
            f.write("")


def setting(sb, key):
    for line in sb.media_file("settings").splitlines():
        if line.split("=", 1)[0].strip() == key:
            return line.split("=", 1)[1].strip().strip('"')
    return None


def test_first_boot_grows_the_root_partition_to_the_end_of_the_sd_card(fppinit):
    """The first boot of a flashed image (fpp_expand_rootfs in the boot
    partition, root on the SD card) rewrites the root partition to run to
    the end of the card, enables fpp-expand-rootfs.service to grow the
    filesystem on the next boot, and leaves rebootFlag set for that boot.

    Regression: bfeb5c05d. Expansion was raspi-config's, so only a Pi had
    it, and the reboot flag the expansion needs was cleared by the same
    boot that set it."""
    sd_card(fppinit)
    fppinit.settings(rebootFlag="0")
    r = start(fppinit)
    calls = fppinit.calls()
    assert "fdisk /dev/mmcblk0" in calls, (calls, r.stdout[-3000:])
    assert "systemctl enable fpp-expand-rootfs.service" in calls, calls
    assert setting(fppinit, "rebootFlag") == "1", fppinit.media_file("settings")


def test_resize_root_fs_grows_the_root_filesystem_once(fppinit):
    """fpp-expand-rootfs.service's step, fppinit resizeRootFS, grows the
    filesystem on the root partition and disables the service again.

    Regression: bfeb5c05d. There was no such action: the partition grown
    at first boot kept its filesystem at the image's size."""
    sd_card(fppinit, marker=False)
    r = fppinit.run("resizeRootFS")
    assert r.returncode == 0, r.stdout + r.stderr
    calls = fppinit.calls()
    assert "resize2fs /dev/mmcblk0p2" in calls, (calls, r.stdout[-3000:])
    assert any(c.startswith("systemctl disable") and "fpp-expand-rootfs.service" in c for c in calls), calls


def test_the_partition_is_rewritten_from_the_last_partitions_number_and_start(fppinit):
    """The commands fed to fdisk delete the last partition (2) and make it
    again from the same start sector to the end of the card: one answer
    per prompt, nothing else.

    Regression: fcb9bd706. parted's answers were used with their trailing
    newlines, so fdisk got an empty answer after each and the start
    sector's grep for "^2<newline>" matched every line of parted's
    listing."""
    sd_card(fppinit)
    start(fppinit)
    assert fppinit.written("/fdisk-input") == "p\nd\n2\nn\np\n2\n1056768\n\np\nw\n", fppinit.written("/fdisk-input")


def test_a_first_boot_expansion_does_not_offer_the_space_it_is_taking(fppinit):
    """On the boot that expands the root partition, UnpartitionedSpace is
    0: the space sfdisk saw after the partition is the space being taken,
    and the UI must not offer to expand into it again.

    Regression: c78c8e80d. The free space was measured after the expansion
    was set up, and recorded as unpartitioned, so the UI prompted to
    resize a card that was being resized."""
    sd_card(fppinit)
    start(fppinit)
    assert "fdisk /dev/mmcblk0" in fppinit.calls(), "precondition: no expansion was done"
    assert setting(fppinit, "UnpartitionedSpace") == "0", fppinit.media_file("settings")


def test_the_expand_marker_is_removed_when_root_is_not_on_the_sd_card(fppinit):
    """A box booted from another disk (root on /dev/sda2, say an NVMe or
    USB drive) with the image's fpp_expand_rootfs marker still in its boot
    partition: nothing is repartitioned, and the marker is removed all the
    same.

    Regression: 13b8ab86b. The marker was only removed when an expansion
    was done, so it stayed for good and every boot went through the check
    again."""
    sd_card(fppinit, root="/dev/sda2")
    start(fppinit)
    assert not any(c.startswith("fdisk") for c in fppinit.calls()), fppinit.calls()
    assert not os.path.exists(os.path.join(fppinit.boot, "fpp_expand_rootfs"))


VC4_HDMI_AND_JACK = (" 0 [vc4hdmi0      ]: vc4-hdmi - vc4-hdmi-0\n                      vc4-hdmi-0\n"
                     " 1 [vc4hdmi1      ]: vc4-hdmi - vc4-hdmi-1\n                      vc4-hdmi-1\n"
                     " 2 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n"
                     "                      bcm2835 Headphones\n")
VC4_HDMI_AND_JACK_APLAY = ("**** List of PLAYBACK Hardware Devices ****\n"
                           "card 0: vc4hdmi0 [vc4-hdmi-0], device 0: MAI PCM i2s-hifi-0 [MAI PCM i2s-hifi-0]\n"
                           "  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n"
                           "card 1: vc4hdmi1 [vc4-hdmi-1], device 0: MAI PCM i2s-hifi-0 [MAI PCM i2s-hifi-0]\n"
                           "  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n"
                           "card 2: Headphones [bcm2835 Headphones], device 0: bcm2835 Headphones [bcm2835 Headphones]\n"
                           "  Subdevices: 8/8\n  Subdevice #0: subdevice #0\n")


def audio_box(sb, cards, aplay, selected, drm=None):
    """A Pi with these sound cards, AudioOutput `selected`, and if given
    HDMI connector status files ({"card1-HDMI-A-1": "connected", ...}) in
    a fake /sys/class/drm. Returns the fakesys maps."""
    maps = fake_boards(sb, cards=cards)
    os.makedirs(os.path.join(sb.state, "run-fppd"), exist_ok=True)
    maps += ":/run/fppd=/fppinit-state/run-fppd"
    drm_dir = os.path.join(sb.state, "drm")
    os.makedirs(drm_dir, exist_ok=True)
    for conn, status in (drm or {}).items():
        os.makedirs(os.path.join(drm_dir, conn), exist_ok=True)
        with open(os.path.join(drm_dir, conn, "status"), "w") as f:
            f.write(status + "\n")  # as sysfs has it
    maps += ":/sys/class/drm=/fppinit-state/drm"
    sb.root_file("/.dockerenv", None)  # nothing is written to /run in a container
    sb.stub_output("aplay", "-l", aplay)
    sb.stub_output("amixer", "scontrols", "Simple mixer control 'PCM',0\n")
    sb.stub_output("pactl", "list", "1\tfpp_alsa_headphones\tPipeWire\ts16le 2ch 44100Hz\tSUSPENDED\n")
    set_setting(sb, AudioOutput=selected, MediaBackend="pipewire-simple")
    return maps


def effective(sb, out):
    eff = sb.written("/fppinit-state/run-fppd/audio-output.json")
    assert eff, f"no /run/fppd/audio-output.json:\n{out[-3000:]}"
    return json.loads(eff)


def test_an_hdmi_card_with_its_display_connected_is_played_on(fppinit):
    """A Pi 4 with its first HDMI port's card selected and a display on
    that port (sysfs status "connected", with its newline): the boot plays
    on that card, no fallback.

    Regression: 3dc743f7a. The status was compared to "connected" without
    its newline, and looked up under a key no card had ("vc4hdmi1" plus
    the drm card number less one), so a connected display read as none
    and the boot fell back off HDMI."""
    maps = audio_box(fppinit, VC4_HDMI_AND_JACK, VC4_HDMI_AND_JACK_APLAY, "vc4hdmi0",
                     drm={"card1-HDMI-A-1": "connected", "card1-HDMI-A-2": "disconnected"})
    out, _ = setup_audio(fppinit, maps)
    assert "has no HDMI connected" not in out, out[-3000:]
    assert effective(fppinit, out) == {"selected": "vc4hdmi0", "effective": "vc4hdmi0", "fallback": False}


LEGACY_HDMI = (" 0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n"
               "                      bcm2835 Headphones\n"
               " 1 [b1             ]: bcm2835_hdmi - bcm2835 HDMI 1\n"
               "                      bcm2835 HDMI 1\n")
LEGACY_HDMI_APLAY = ("**** List of PLAYBACK Hardware Devices ****\n"
                     "card 0: Headphones [bcm2835 Headphones], device 0: bcm2835 Headphones [bcm2835 Headphones]\n"
                     "  Subdevices: 8/8\n  Subdevice #0: subdevice #0\n"
                     "card 1: b1 [bcm2835 HDMI 1], device 0: bcm2835 HDMI 1 [bcm2835 HDMI 1]\n"
                     "  Subdevices: 4/4\n  Subdevice #0: subdevice #0\n")


def test_a_legacy_bcm2835_hdmi_card_with_no_display_is_not_played_on(fppinit):
    """A Pi whose HDMI audio is the legacy bcm2835 driver's card ("b1",
    bcm2835 HDMI 1), selected, with no display connected anywhere: the
    boot falls back to the headphone jack.

    Regression: 819cfebee. Only a vc4hdmi card was ever judged dead, so
    the boot played on an HDMI port with nothing on it, and fppinit's own
    flite IP announcement to it panicked the kernel."""
    maps = audio_box(fppinit, LEGACY_HDMI, LEGACY_HDMI_APLAY, "b1",
                     drm={"card0-HDMI-A-1": "disconnected"})
    out, _ = setup_audio(fppinit, maps)
    assert "has no HDMI connected" in out, out[-3000:]
    assert effective(fppinit, out) == {"selected": "b1", "effective": "Headphones", "fallback": True}
