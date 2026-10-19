"""fppinit, one action at a time, in a sandbox (fppinit.py): what it writes
to the media directory, /etc and /boot/firmware, and which commands it
would run, from the configuration a scenario gives it.

fppinit has no one to restart it -- a crash at boot leaves the box
half set up -- so a bad config file must be survived here too.
"""

import json
import os

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

L = [1]
O = {"a": 1}


def on_pi():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith("Raspberry Pi")
    except OSError:
        return False


pi_only = pytest.mark.skipif(not on_pi(), reason="setupChannelOutputs only does anything on a Pi")


def assert_clean(r):
    out = r.stdout + r.stderr
    assert "terminate called" not in out and "AddressSanitizer" not in out, out[-3000:]
    assert r.returncode == 0, f"fppinit exited {r.returncode}:\n{out[-3000:]}"


def test_runs_in_the_media_directory_it_is_given(fppinit):
    """FPP_MEDIA_DIR moves fppinit's media directory -- its log and the
    settings it reads -- and /home/fpp/media is left alone (e930dec80;
    every other scenario here relies on it)."""
    fppinit.settings(TimeZone="America/New_York")
    r = fppinit.run("setupTimezone")
    assert_clean(r)
    assert "Running FPPINIT setupTimezone" in fppinit.media_file("logs/fppd.log")
    assert fppinit.written("/home/fpp/media/logs/fppd.log") is None, \
        "fppinit wrote to /home/fpp/media"


@pi_only
def test_rpiws281x_strings_migrate_to_dpi(fppinit):
    """The removed RPIWS281X string output is migrated to DPIPixels as the
    box boots: an rPi-28D becomes the 4-output DPI variant with its ws2801
    output now ws2811, the DPI overlay goes into config.txt, and the box
    reboots to load it."""
    fppinit.write("config/co-pixelStrings.json", {"channelOutputs": [{
        "type": "RPIWS281X", "subType": "rPi-28D", "enabled": 1, "startChannel": 1,
        "channelCount": 900, "outputs": [{"protocol": "ws2811", "virtualStrings": []},
                                         {"protocol": "ws2811", "virtualStrings": []},
                                         {"protocol": "ws2801", "virtualStrings": []}]}]})
    with open(os.path.join(fppinit.boot, "config.txt"), "w") as f:
        f.write("[all]\ndtparam=audio=on\n")
    r = fppinit.run("setupChannelOutputs")
    assert_clean(r)
    out = json.loads(fppinit.media_file("config/co-pixelStrings.json"))["channelOutputs"][0]
    assert out["type"] == "DPIPixels", out
    assert out["subType"] == "rPi-28D-DPIPixels-4", out
    assert [o["protocol"] for o in out["outputs"]] == ["ws2811"] * 3, out["outputs"]
    assert "dtoverlay=vc4-kms-dpi-fpp," in fppinit.boot_file("config.txt")
    assert any(c.startswith("reboot") for c in fppinit.calls()), fppinit.calls()


@pi_only
def test_no_dpi_output_removes_the_overlay(fppinit):
    """With no DPI output configured, a DPI overlay left in config.txt is
    taken out (and the box reboots); with nothing to change, it doesn't."""
    with open(os.path.join(fppinit.boot, "config.txt"), "w") as f:
        f.write("[all]\ndtoverlay=vc4-kms-dpi-fpp,rgb888,hactive=1920\ndtparam=audio=on\n")
    assert_clean(fppinit.run("setupChannelOutputs"))
    assert "vc4-kms-dpi-fpp" not in fppinit.boot_file("config.txt")
    assert any(c.startswith("reboot") for c in fppinit.calls())
    assert_clean(fppinit.run("setupChannelOutputs"))
    assert not any(c.startswith("reboot") for c in fppinit.calls()), "rebooted with nothing changed"


@pi_only
@pytest.mark.parametrize("files", [
    {"config/channeloutputs.json": {"channelOutputs": [5, {"subType": L, "enabled": "1"}]}},
    {"config/channeloutputs.json": {"channelOutputs": {"a": 1}}},
    {"config/channeloutputs.json": [1, 2]},
    {"config/co-pixelStrings.json": {"channelOutputs": ["x", {"type": O}]}},
    {"config/co-pixelStrings.json": {"channelOutputs": [{
        "type": "RPIWS281X", "subType": "rPi-28D", "enabled": 1, "outputs": [5, {"protocol": L}]}]}},
    {"config/co-pixelStrings.json": {"channelOutputs": [{
        "type": "RPIWS281X", "subType": L, "enabled": "yes", "outputs": {"a": 1}}]}},
], ids=["channeloutputs entries", "channeloutputs object", "channeloutputs list",
        "pixelStrings entries", "pixelStrings outputs", "pixelStrings fields"])
def test_setup_channel_outputs_survives_wrong_types(fppinit, files):
    """Channel output configs with values of the wrong JSON type are
    skipped where they can't be read, not thrown on: fppinit runs this
    step on every boot.

    Regression: e930dec80. Each case terminated fppinit on
    Json::LogicError before it."""
    for name, content in files.items():
        fppinit.write(name, content)
    assert_clean(fppinit.run("setupChannelOutputs"))


@pytest.mark.parametrize("content", [
    {"groups": [5, {"members": [5, {"cardId": L}]}]},
    {"groups": {"a": 1}},
    {"groups": [{"members": {"a": 1}}]},
], ids=["entries", "groups object", "members object"])
def test_setup_audio_survives_wrong_typed_audio_groups(fppinit, content):
    """setupAudio reads the PipeWire audio group configs (the full and the
    simple one) to check their cards are still present; values of the
    wrong JSON type there are treated as a stale config, not thrown on.

    Regression: e930dec80. Each case terminated fppinit on
    Json::LogicError before it."""
    fppinit.settings(MediaBackend="pipewire-simple")
    fppinit.write("config/pipewire-audio-groups.json", content)
    fppinit.write("config/pipewire-audio-groups-simple.json", content)
    assert_clean(fppinit.run("setupAudio", timeout=180))


def test_leaving_ap_mode_stops_hostapd_before_the_wifi_client(fppinit):
    """Switching a Wi-Fi interface from the tethering access point to a
    client network stops hostapd before the client's wpa_supplicant is
    (re)started -- a supplicant started beside a hostapd still holding the
    radio often failed to associate until a power cycle -- and a hostapd
    that stopped cleanly isn't then SIGKILLed.

    Regression: 8f0eb2b51. The supplicant was started first; and the
    "did it stop?" check matched the "active" inside "inactive", so every
    clean stop was followed by a kill. On a system without /etc/wpa_supplicant
    (the container image) setupNetwork aborted before reaching any of this
    until 57e923023, so there the red check for 8f0eb2b51 needs a base with
    57e923023 in it.
    """
    fppinit.write("config/interface.wlan0",
                  'INTERFACE="wlan0"\nPROTO="dhcp"\nSSID="TestNet"\nPSK="testpass123"\n')
    fppinit.service("hostapd", enabled=True, active=True)
    r = fppinit.run("setupNetwork")
    assert_clean(r)
    calls = fppinit.calls()
    stop = [i for i, c in enumerate(calls) if c.startswith("systemctl") and "stop hostapd" in c]
    client = [i for i, c in enumerate(calls)
              if c.startswith("systemctl") and "wpa_supplicant@wlan0" in c and "restart" in c]
    assert stop, f"hostapd was never stopped: {calls}"
    assert client, f"the Wi-Fi client was never started: {calls}"
    assert stop[0] < client[0], f"wpa_supplicant started before hostapd stopped: {calls}"
    assert not [c for c in calls if "kill" in c and "hostapd" in c], f"hostapd was killed: {calls}"


@pytest.mark.parametrize("field", ["TetherPSK", "TetherSSID"])
def test_tether_credentials_are_not_run_as_shell(fppinit, field):
    """The tethering SSID and PSK reach the Wi-Fi QR code as data: a value
    with $(...) in it is printed in the code, not run.

    Regression: 626d00a75. Both were pasted inside double quotes into the
    qrencode command line, so "$(...)" ran as root whenever the hostapd
    config was written -- and the settings API only refuses CR, LF and NUL
    in them."""
    if not os.path.exists("/usr/bin/qrencode"):
        pytest.skip("no qrencode here")
    fppinit.settings(EnableTethering="1", TetherInterface="wlan0",
                     **{field: "a$(touch /fpp-test-media/pwned)b"})
    r = fppinit.run("setupNetwork")
    assert_clean(r)
    assert not fppinit.media_exists("pwned"), f"{field} was run by the shell"
    assert fppinit.media_exists("tmp/wifi-L.ascii"), "no QR code was written"
