"""Boot and upgrade steps that set up media playback, in the fppinit
sandbox (fppinit.py): the PipeWire GStreamer plugin an upgrade restores,
the MediaBackend a retired value is moved off, how many channels a card's
ALSA adapter is given, and the Wi-Fi supplicant restart.

What is checked is the files written and the commands run, as the stubs
record them.
"""

import os

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_fppinit_audio_cards import SINKS
from test_fppinit_boot_services import ssh_dir  # noqa: F401
from test_fppinit_network_boot import run, with_config_dirs
from test_fppinit_pipewire_boot import boot, usb_box
from test_fppinit import assert_clean

PLUGIN_DIR = "/usr/lib/fpp-test-gst"
PLUGIN = PLUGIN_DIR + "/libgstpipewire.so"


def plugin_box(sb, current, stock="1.4.2"):
    """A Debian box whose GStreamer PipeWire plugin is `current` (what
    gst-inspect says) over a .bak- copy of the distro one, `stock` being the
    distro package's version."""
    sb.root_file("/etc/debian_version", "13.0\n")
    sb.root_file("/usr/bin/pkg-config", f"#!/bin/sh\necho {PLUGIN_DIR}\n")
    sb.root_file("/usr/bin/gst-inspect-1.0", f"#!/bin/sh\necho '  Version                  {current}'\n")
    sb.root_file("/usr/bin/dpkg-query", f"#!/bin/sh\necho '{stock}-1'\n")
    sb.root_file(PLUGIN, "built against PipeWire 1.6.0\n")
    sb.root_file(PLUGIN + ".bak-20260101", "the distro's plugin\n")
    sb.root_file("/root/.cache/gstreamer-1.0/registry.x86_64.bin", "cache\n")


def after_125(sb):
    r = sb._run(["sh", "-c", "/opt/fpp/upgrade/125/upgrade.sh; "
                 f"cat {PLUGIN} > {MEDIA}/tmp/plugin; "
                 f"ls /root/.cache/gstreamer-1.0 > {MEDIA}/tmp/cache"], timeout=120, media_home=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return sb.media_file("tmp/plugin"), sb.media_file("tmp/cache").split()


def test_upgrade_125_puts_back_the_distros_pipewire_gstreamer_plugin(fppinit):
    """Upgrade 125 restores the newest .bak- copy over libgstpipewire.so
    when the installed plugin is not the distro's version, and clears the
    GStreamer registry caches; with the distro's own plugin installed it
    leaves everything alone.

    Added in 0d49ef2ed: a device that had run the removed upgrade 124 had a
    PipeWire 1.6 plugin over the 1.4 library, and playlists ran with no sound
    and no error."""
    plugin_box(fppinit, current="1.6.0")
    plugin, cache = after_125(fppinit)
    assert plugin == "the distro's plugin\n" and cache == [], (plugin, cache)

    plugin_box(fppinit, current="1.4.2")
    plugin, cache = after_125(fppinit)
    assert plugin == "built against PipeWire 1.6.0\n" and cache == ["registry.x86_64.bin"], (plugin, cache)


def test_a_retired_alsa_media_backend_is_moved_to_pipewire_simple(fppinit):
    """setupAudio with MediaBackend "alsa" (the retired Hardware Direct
    backend) says so, saves pipewire-simple in its place and sets the
    PipeWire audio up.

    Regression: 973abf256 (the ALSA paths removed). A device still set to
    alsa took paths that no longer existed."""
    maps = usb_box(fppinit)
    from test_fppinit_audio_cards import set_setting
    set_setting(fppinit, MediaBackend="alsa")
    out = boot(fppinit, maps)
    assert "MediaBackend 'alsa' is retired" in out, out[-2500:]
    assert 'MediaBackend = "pipewire-simple"' in fppinit.media_file("settings"), fppinit.media_file("settings")
    assert 'node.name = "fpp_alsa_device"' in (fppinit.written(SINKS) or "")


ANALOG_CARD = " 0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n                      bcm2835 Headphones\n"


def adapter_channels(sb, params, usb):
    """The audio.channels setupAudio gives a card whose hw_params say
    `params` for CHANNELS: a USB audio device, or a Pi's onboard analog."""
    import re
    from test_audio_boot_cards import fake_boards
    from test_fppinit_audio_cards import set_setting
    cid, line, cards = (("Device", "card 0: Device [USB Audio Device], device 0: USB Audio [USB Audio]\n",
                         " 0 [Device         ]: USB-Audio - USB Audio Device\n                      C-Media USB Audio Device at usb-1\n")
                        if usb else
                        ("Headphones", "card 0: Headphones [bcm2835 Headphones], device 0: bcm2835 Headphones [bcm2835 Headphones]\n",
                         ANALOG_CARD))
    maps = fake_boards(sb, cards=cards)
    sb.stub_output("aplay", "-l", "**** List of PLAYBACK Hardware Devices ****\n" + line +
                   "  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n")
    sb.stub_output("aplay", f"hw:{cid}", f'HW Params of device "hw:{cid}":\n--------------------\n'
                   "ACCESS:  MMAP_INTERLEAVED RW_INTERLEAVED\nFORMAT:  S16_LE\nSUBFORMAT:  STD\n"
                   f"SAMPLE_BITS: 16\nFRAME_BITS: 32\nCHANNELS: {params}\nRATE: [8000 192000]\n"
                   "PERIOD_SIZE: [80 131072]\nBUFFER_SIZE: [80 131072]\n--------------------\n")
    sb.stub_output("amixer", "scontrols", "Simple mixer control 'PCM',0\n")
    sb.stub_output("pactl", "list", f"1\tfpp_alsa_{cid.lower()}\tPipeWire\ts16le 2ch 44100Hz\tSUSPENDED\n")
    set_setting(sb, AudioOutput=cid, MediaBackend="pipewire-simple")
    sb.root_file("/.dockerenv", None)
    boot(sb, maps)
    m = re.search(r"audio.channels = (\d+)", sb.written(SINKS) or "")
    assert m, sb.written(SINKS)
    return int(m.group(1))


def test_a_card_that_takes_one_to_eight_channels_is_given_two(fppinit):
    """A Pi's onboard analog (not a USB device) whose hw_params say
    CHANNELS: [1 8] gets a stereo ALSA adapter, one that says CHANNELS: 8
    gets eight, and a USB audio device's range is taken at its top end.

    Regression: 0fed12a5d (the USB split came later). A range was read as
    its top end, so a stereo jack was opened for eight channels and played
    garbled noise."""
    assert adapter_channels(fppinit, "[1 8]", usb=False) == 2
    assert adapter_channels(fppinit, "8", usb=False) == 8
    assert adapter_channels(fppinit, "[1 8]", usb=True) == 8, "a USB device's range is its real channel count"


def test_a_changed_wifi_config_enables_and_restarts_its_supplicant_without_asking_systemd(fppinit):
    """setupNetwork with a Wi-Fi client config queues enabling and
    restarting wpa_supplicant@<if> unconditionally, and makes no
    is-active or is-enabled query on the way (those block for seconds on a
    boot-time systemd).

    Regression: e1de78b28. The two queries stalled fppinit ~9 s on a
    BeagleBone while systemd was still starting its first services."""
    with_config_dirs(fppinit)
    fppinit.settings(bootDelay="0")
    fppinit.write("config/interface.wlan0", 'INTERFACE="wlan0"\nPROTO="dhcp"\nSSID="Home"\nPSK="secretsecret"\n')
    ssh_dir(fppinit, "ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub", "ssh_host_rsa_key", "ssh_host_rsa_key.pub")
    assert_clean(fppinit.run("start"))
    calls = fppinit.calls()
    assert 'systemctl enable "wpa_supplicant@wlan0.service" &' in calls or \
        "systemctl enable wpa_supplicant@wlan0.service" in calls, calls
    assert not [c for c in calls if c.startswith(("systemctl is-active wpa_supplicant", "systemctl is-enabled wpa_supplicant"))], calls
