"""setupAudio's PipeWire config decisions at boot, on a USB sound card the
fppinit sandbox fakes (fakesys.c serves /proc/asound): which files it writes,
what it leaves alone on the next boot, and whether it restarts the stack.

Each boot is a sandbox run of its own; what one run left in /etc is planted
for the next, as a box carries it from one boot to the next
(test_fppinit_audio_cards.py does the same on a real card).
A running fpp-pipewire is told to the stub systemctl by service().
"""

import os

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_audio_boot_cards import fake_boards
from test_fppinit_audio_cards import CARRIED, RULES, SINKS, set_setting
from test_fppinit_boot_misc import USB_CARD

CARRY = CARRIED + ("/etc/pipewire/pipewire.conf.d/96-fpp-input-groups.conf",)


def usb_box(sb):
    maps = fake_boards(sb, cards=USB_CARD)
    sb.stub_output("aplay", "-l", "**** List of PLAYBACK Hardware Devices ****\n"
                   "card 0: Device [USB Audio Device], device 0: USB Audio [USB Audio]\n"
                   "  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n")
    sb.stub_output("aplay", "hw:Device", 'HW Params of device "hw:Device":\n--------------------\n'
                   "ACCESS:  MMAP_INTERLEAVED RW_INTERLEAVED\nFORMAT:  S16_LE\nSUBFORMAT:  STD\n"
                   "SAMPLE_BITS: 16\nFRAME_BITS: 32\nCHANNELS: 2\nRATE: [8000 192000]\n"
                   "PERIOD_SIZE: [80 131072]\nBUFFER_SIZE: [80 131072]\n--------------------\n")
    sb.stub_output("amixer", "scontrols", "Simple mixer control 'PCM',0\n")
    sb.stub_output("pactl", "list", "1\tfpp_alsa_device\tPipeWire\ts16le 2ch 44100Hz\tSUSPENDED\n")
    set_setting(sb, AudioOutput="Device", MediaBackend="pipewire-simple")
    sb.root_file("/.dockerenv", None)
    return maps


def boot(sb, maps):
    r = sb._run(["env", "LD_PRELOAD=/fpp-test-media/fakesys.so", "FAKESYS=" + maps,
                 "ASAN_OPTIONS=verify_asan_link_order=0:detect_leaks=0", "/opt/fpp/src/fppinit", "setupAudio"],
                timeout=300, media_home=True)
    out = r.stdout + r.stderr
    assert "AddressSanitizer" not in out and "terminate called" not in out and r.returncode == 0, out[-3000:]
    return out


def carry(sb):
    """Plant every file the last run left under /etc/pipewire and
    /etc/wireplumber (configs, the linking hook) for the next run."""
    for top in ("etc/pipewire", "etc/wireplumber", "usr/share/wireplumber"):
        for root, _, files in os.walk(os.path.join(sb.upper, top)):
            for f in files:
                path = os.path.join(root, f)
                with open(path, errors="replace") as fh:
                    sb.root_file("/" + os.path.relpath(path, sb.upper), fh.read())


def test_a_card_with_a_static_adapter_is_suppressed_in_wireplumbers_monitor(fppinit):
    """setupAudio writes 50-fpp-suppress-alsa-dupes.conf, which disables the
    ALSA monitor's own device for each card FPP already has a static
    fpp_alsa_* adapter for, matched on api.alsa.card.name (the card's short
    name, which is set when the rules run).

    Regression: a7ec08c4a. WirePlumber made a second node on the same PCM,
    it won the default-sink election and failed to open (EBUSY), and every
    stream on the box hung forever."""
    out = boot(fppinit, usb_box(fppinit))
    rules = fppinit.written(RULES) or ""
    assert 'matches = [ { api.alsa.card.name = "USB Audio Device" } ]' in rules, f"{rules}\n{out[-2000:]}"
    assert "device.disabled = true" in rules, rules
    assert 'node.name = "fpp_alsa_device"' in (fppinit.written(SINKS) or ""), "no static adapter, so this proves nothing"


def php_calls(sb):
    return sb.media_file("tmp/php.log") if sb.media_exists("tmp/php.log") else ""


def second_boot(sb, maps):
    """The box after a first boot, with its stack running: what the first
    boot wrote is in /etc, and php is a recorder."""
    boot(sb, maps)
    carry(sb)
    sb.service("fpp-pipewire", active=True)
    sb.root_file("/usr/bin/php", "#!/bin/sh\necho php $* >> /fpp-test-media/tmp/php.log\n")
    sb.write("tmp/php.log", "")


def test_a_second_boot_with_an_unchanged_pipewire_config_restarts_nothing_and_runs_no_php(fppinit):
    """With the config the first boot wrote still in place and PipeWire
    running, the next setupAudio leaves the stack alone: no restart of
    fpp-pipewire and no PHP regeneration. With a setting changed that the cached
    groups config bakes in (passive sinks), it does regenerate.

    Regressions: db853ceb8 (an unchanged config no longer reconfigures and
    restarts PipeWire) and 2ac7a28eb (the check that the config would not
    change is made in C++, so PHP is not forked on every boot)."""
    maps = usb_box(fppinit)
    second_boot(fppinit, maps)
    out = boot(fppinit, maps)
    assert "unchanged since boot; skipping restart" in out, out[-2500:]
    assert not [c for c in fppinit.calls() if c.startswith("systemctl restart fpp-pipewire")], fppinit.calls()
    assert php_calls(fppinit) == "", php_calls(fppinit)

    carry(fppinit)
    set_setting(fppinit, PipeWirePassiveSinks="0")  # the cached conf no longer says what the setting does
    out = boot(fppinit, maps)
    assert "regenerate_pipewire_groups" in php_calls(fppinit), f"a changed config was not regenerated:\n{out[-2500:]}"
