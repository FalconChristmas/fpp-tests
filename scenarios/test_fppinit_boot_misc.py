"""More of what fppinit does at boot, one sandbox run each: network module
detection, the mixer choice, the Wi-Fi client restart, the kiosk install
trigger.

Run in the fppinit sandbox (fppinit.py); what is checked is the files
written and the commands run, as the stubs record them.
"""

import os

from fppinit import Link, fppinit  # noqa: F401 -- the fixture
from test_audio_boot_cards import fake_boards, setup_audio
from test_fppinit import assert_clean
from test_fppinit_audio_cards import set_setting

USB_CARD = " 0 [Device         ]: USB-Audio - USB Audio Device\n                      C-Media USB Audio Device at usb-1\n"


def test_network_modules_are_listed_by_their_driver_module_name(fppinit):
    """detectNetworkModules writes the kernel module behind each network
    interface's driver to /etc/modules-load.d/fpp-network.conf, one name per
    line, whatever follows the link's last slash.

    Regression: 9836227af. The readlink result was never terminated, so the
    name was followed by whatever the stack held."""
    fppinit.root_file("/tmp/fpp-dev/module/smsc95xx/.keep", "")
    fppinit.root_file("/etc/modules-load.d/.keep", "")
    fppinit.fake_path("/sys/class/net", {"lo/flags": "0x9\n", "eth0/flags": "0x1003\n",
                                         "eth0/device/driver/module": Link("/tmp/fpp-dev/module/smsc95xx")})
    assert_clean(fppinit.run("detectNetworkModules"))
    assert fppinit.written("/etc/modules-load.d/fpp-network.conf") == "smsc95xx\n"


def test_the_chosen_mixer_is_kept_when_it_is_not_the_cards_first_control(fppinit):
    """A card with several mixer controls keeps the AudioMixerDevice that is
    one of them, whichever it is, and falls back to the first when the one set
    is not there.

    Regression: aa29d4dab (#2083). Only the card's first control was read,
    so a USB card whose PCM control came second had its mixer reset to the
    other one at every boot."""
    maps = fake_boards(fppinit, cards=USB_CARD)
    fppinit.stub_output("aplay", "-l", "**** List of PLAYBACK Hardware Devices ****\n"
                        "card 0: Device [USB Audio Device], device 0: USB Audio [USB Audio]\n"
                        "  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n")
    fppinit.stub_output("amixer", "scontrols", "Simple mixer control 'Master',0\nSimple mixer control 'PCM',0\n")
    set_setting(fppinit, AudioOutput="Device", AudioMixerDevice="PCM", MediaBackend="pipewire-simple")
    fppinit.root_file("/.dockerenv", None)
    setup_audio(fppinit, maps)
    assert 'AudioMixerDevice = "PCM"' in fppinit.media_file("settings"), fppinit.media_file("settings")

    set_setting(fppinit, AudioMixerDevice="Speaker")
    setup_audio(fppinit, maps)
    assert 'AudioMixerDevice = "Master"' in fppinit.media_file("settings"), fppinit.media_file("settings")


def test_a_wifi_client_whose_wpa_supplicant_is_enabled_but_down_is_restarted_at_boot(fppinit):
    """postNetwork restarts wpa_supplicant@wlan0 when it is enabled and not
    running, and leaves it alone when it is running.

    Regression: d75f17566. After a reboot from tethering the supplicant
    could be enabled and dead, and the box never found its Wi-Fi."""
    from test_fppinit_network_boot import run
    fppinit.settings(bootDelay="0")
    fppinit.service("wpa_supplicant@wlan0", enabled=True, active=False)
    assert_clean(run(fppinit, "postNetwork", net=True))
    assert "systemctl restart wpa_supplicant@wlan0.service" in fppinit.calls(), fppinit.calls()
    fppinit.service("wpa_supplicant@wlan0", enabled=True, active=True)
    assert_clean(run(fppinit, "postNetwork", net=True))
    assert not [c for c in fppinit.calls() if "restart wpa_supplicant" in c], fppinit.calls()


def test_leaving_the_tether_stops_hostapd_before_the_supplicant_is_restarted(fppinit):
    """The interactive network apply (setupNetwork) switching a box from the
    tether to a Wi-Fi client stops hostapd first, reloads systemd and
    networkd, and then restarts wpa_supplicant a second time once networkd
    has the new config.

    Regression: 67feb9844. The supplicant was started beside a hostapd that
    still held the radio and never associated."""
    from test_fppinit_network_boot import run, with_config_dirs
    with_config_dirs(fppinit)
    fppinit.settings(bootDelay="0")
    fppinit.service("hostapd", enabled=True, active=True)
    fppinit.write("config/interface.wlan0", 'INTERFACE="wlan0"\nPROTO="dhcp"\nSSID="Home"\nPSK="secretsecret"\n')
    assert_clean(run(fppinit, "setupNetwork", net=True))
    calls = [c for c in fppinit.calls() if c.startswith("systemctl") and not c.startswith("systemctl is-")]
    stop = calls.index("systemctl stop hostapd.service")
    reloads = [i for i, c in enumerate(calls) if c == "systemctl daemon-reload"]
    nets = [i for i, c in enumerate(calls) if "reload-or-restart systemd-networkd.service" in c]
    wpa = [i for i, c in enumerate(calls) if "reload-or-restart wpa_supplicant@wlan0.service" in c]
    assert stop < reloads[0] and len(reloads) == 2 and len(nets) == 2 and wpa[-1] > nets[-1] > reloads[-1], calls


def test_boot_installs_the_kiosk_only_when_asked_and_missing(fppinit):
    """With the kiosk wanted (Kiosk setting or an /fpp_kiosk marker) and no
    /etc/fpp/kiosk, start enables fpp-install-kiosk and reboots to run it;
    with the kiosk already there, or not wanted, it doesn't.

    Regression: ab503be42. The install ran inside fpp_postnetwork, whose
    timeout it could outlast, so the kiosk was never finished."""
    from test_fppinit_boot_config import start
    fppinit.service("fpp-install-kiosk", enabled=False)
    fppinit.root_file("/etc/fpp/kiosk", None)
    start(fppinit)
    assert not [c for c in fppinit.calls() if "fpp-install-kiosk" in c and "enable" in c and "is-" not in c]

    fppinit.settings(Kiosk="1")
    start(fppinit)
    assert "systemctl enable fpp-install-kiosk" in fppinit.calls(), fppinit.calls()
    assert any(c.startswith("reboot") for c in fppinit.calls()), fppinit.calls()

    fppinit.root_file("/etc/fpp/kiosk", "")
    start(fppinit)
    assert not [c for c in fppinit.calls() if "enable fpp-install-kiosk" in c], fppinit.calls()
