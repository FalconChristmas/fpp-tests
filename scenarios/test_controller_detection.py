"""Controller detection: fppd's HTTP discovery probes the addresses in
MultiSyncHTTPSubnets, reads each front page, asks the device's own API where
the vendor has one, and lists what it found in /fppd/multiSyncSystems.

The devices are fakes in their own network namespace (fake_devices.py),
answering with the pages and API replies each vendor's detector looks for.
"""

import pytest

from fake_devices import drop, fake_devices, page, requests_seen

FPP = {
    "/": page("<html><title>Falcon Player - FPP</title></html>"),
    "/api/system/info": page({"HostName": "fake-fpp", "Version": "9.5", "Variant": "Pi 4",
                              "Mode": "remote", "majorVersion": 9, "minorVersion": 5,
                              "uuid": "M1-fake-fpp-uuid", "channelRanges": "0-511"}),
}
FALCON = {
    "/": page('<html><link href="css/falcon.css"></html>'),
    "/status.xml": page("<status><p>128</p><np>16</np><fv>2.0 4</fv><n>fake-falcon</n></status>",
                        ctype="text/xml"),
    "/api": page({"P": {"C": "AA:BB:CC:00:00:03"}}),
}
ESPS = {
    "/": page('<html><script src="esps.js"></script></html>'),
    "/conf": page({"network": {"hostname": "fake-esps"}}),
}
WLED = {
    "/": page("<html><title>WLED UI</title></html>"),
    "/json/info": page({"ver": "0.14.1", "name": "fake-wled", "arch": "esp32",
                        "mac": "aabbcc000005"}),
}
TWINKLY = {
    "/": page("This URI does not exist", status=404),
    "/xled/v1/gestalt": page({"product_name": "Twinkly", "device_name": "fake-twinkly",
                              "product_code": "TWS600STP",
                              "uuid": "00000000-1111-2222-3333-444444444444"}),
    "/xled/v1/fw/version": page({"version": "2.8.15"}),
}
SANDEVICES = {
    "/": page("<html>Controller Model E682 <table><tr><th>MAC Address:</th><td>00:11:22:00:00:07"
              "</td></tr><tr><th>Firmware Version:</th></td><td>5.051</td></tr></table></html>"),
}
UNKNOWN = {"/": page("<html>Some other web page</html>")}

DEVICES = {
    "10.88.0.2": FPP, "10.88.0.3": FALCON, "10.88.0.4": ESPS, "10.88.0.5": WLED,
    "10.88.0.6": TWINKLY, "10.88.0.7": SANDEVICES, "10.88.0.8": UNKNOWN,
}


def systems(fppd):
    return {s["address"]: s for s in fppd.get("/fppd/multiSyncSystems")["systems"]
            if not s.get("local")}


def discover(fppd, devices, subnets=None, timeout=30, want=None):
    """Start fppd scanning `subnets` (default: each device, exactly) and wait
    for `want` (default: every device) to be listed."""
    want = set(want if want is not None else devices)
    fppd.settings(MultiSyncHTTPSubnets=subnets or ",".join(devices))
    fppd.start()
    fppd.wait_for(lambda: want <= set(systems(fppd)), timeout=timeout, interval=0.5,
                  what=f"{sorted(want - set(systems(fppd)))} to be listed")
    return systems(fppd)


def test_each_vendor_is_recognised(fppd):
    with fake_devices(DEVICES):
        got = discover(fppd, DEVICES)
    def row(a):
        s = got[a]
        return (s["hostname"], s["type"], s["version"], s["uuid"])
    assert row("10.88.0.2")[:3] == ("fake-fpp", "Raspberry Pi 4", "9.5"), got["10.88.0.2"]
    assert got["10.88.0.2"]["uuid"] == "M1-fake-fpp-uuid"
    assert row("10.88.0.3")[0] == "fake-falcon" and "F16" in row("10.88.0.3")[1], got["10.88.0.3"]
    assert row("10.88.0.3")[3].upper().endswith("AABBCC000003"), got["10.88.0.3"]
    assert row("10.88.0.4")[0] == "fake-esps" and row("10.88.0.4")[1].startswith("ESPixelStick"), got["10.88.0.4"]
    assert row("10.88.0.5")[:3] == ("fake-wled", "WLED", "0.14.1"), got["10.88.0.5"]
    assert row("10.88.0.5")[3].upper().endswith("AABBCC000005"), got["10.88.0.5"]
    assert row("10.88.0.6") == ("fake-twinkly", "Twinkly", "2.8.15",
                                "00000000-1111-2222-3333-444444444444"), got["10.88.0.6"]
    assert row("10.88.0.7")[1:3] == ("SanDevices", "5.051"), got["10.88.0.7"]
    assert row("10.88.0.7")[3].upper().endswith("001122000007"), got["10.88.0.7"]
    assert got["10.88.0.8"]["type"] == "Unknown System Type", got["10.88.0.8"]


# Replies a device on the LAN might send, of the right shape but with fields
# of the wrong JSON type. Each one used to throw inside a detector.
MALFORMED = {
    "fpp": {"/": FPP["/"], "/api/system/info": page({"HostName": {"a": 1}, "majorVersion": "9"})},
    "esps": {"/": ESPS["/"], "/conf": page({"network": {"hostname": [1, 2]}})},
    "wled": {"/": WLED["/"], "/json/info": page({"ver": 14, "name": {}, "mac": 5})},
    "twinkly": {"/": TWINKLY["/"], "/xled/v1/gestalt": page({"product_name": ["Twinkly"]})},
}


@pytest.mark.parametrize("kind", list(MALFORMED))
def test_a_reply_of_the_wrong_shape_still_finishes_the_probe(fppd, kind):
    """A device whose API reply has a field of the wrong JSON type is still
    listed (as Unknown, or as far as its reply could be read), and fppd
    carries on.

    Regression: 9c5cd05f9. The detector threw reading the field. CurlManager caught it,
    but the detection was neither matched nor passed on, so it never
    finished: the device was never listed, and the discovery slot it held was
    never given back.
    """
    with fake_devices({"10.88.0.2": MALFORMED[kind]}):
        discover(fppd, ["10.88.0.2"], timeout=20)


def test_odd_devices_do_not_stop_discovery_of_the_rest(fppd):
    """Fifty devices with a malformed reply ahead of a real one in a subnet
    scan: the real one is still found.

    Regression: 9c5cd05f9. Each malformed reply stranded its probe for good, and the
    scan runs 48 probes at a time, so 48 of them stopped it for the rest of
    fppd's run.
    """
    devices = {f"10.88.0.{i}": MALFORMED["fpp"] for i in range(10, 60)}
    devices["10.88.0.9"] = WLED  # "10.88.0.9" sorts after every "10.88.0.1x".."5x"
    with fake_devices(devices):
        got = discover(fppd, devices, subnets="10.88.0.[9-59]", want=["10.88.0.9"], timeout=60)
    assert got["10.88.0.9"]["hostname"] == "fake-wled"


def test_a_hostile_front_page_does_not_crash_the_regex_detectors(fppd):
    """A device whose front page holds a long run of digits after a prefix
    one of the detector regexes looks for is listed (as Unknown), and fppd
    stays up.

    Regression: af04eaead. The detectors ran std::regex_search with unbounded
    quantifiers ("js/cntrlr_(\\d+).js", "(\\d+) Port ...") on the main loop.
    GCC 14's libstdc++ regex executor recurses once per repeated character,
    so ~30KB of digits overflowed the stack: SIGSEGV from one web page.
    """
    digits = "7" * 100_000
    hostile = {"/": page('<html><script src="js/cntrlr_' + digits + '.js"></script>'
                         + digits + " Port Ethernet to SPI Controller</html>")}
    with fake_devices({"10.88.0.2": hostile, "10.88.0.3": WLED}):
        got = discover(fppd, ["10.88.0.2", "10.88.0.3"], timeout=30)
    assert got["10.88.0.3"]["hostname"] == "fake-wled"
    assert fppd.get("/fppd/status")["status_name"]


def fields(s, *keys):
    return tuple(s[k] for k in keys)


def test_baldrick_boards_are_read_from_system_state_and_settings(fppd):
    """Baldrick boards (a page that says "Baldrick Board") are identified from
    /system_state, and named from /settings:

    - older firmware, with the version on "ota" ("v3.5.4"): model from
      board_model, version kept as sent, major 3 and minor 5, the board's own
      id as its MAC identity, hostname from /settings, bridge mode;
    - current firmware, with the version on the first "ota.updatable" entry
      that has one ("4.12.7", not the later "9.9.9"), no board_model (model
      stays "Baldrick"), and no /settings (hostname stays the address);
    - a version with no dot ("v7") is reported as sent, with 0.0;
    - the first board's "buddies" list gives the second board, which states
      no id of its own, its identity; a buddy that has a real UUID (a
      Twinkly) keeps it, a buddy nobody discovered is not listed, and an
      entry that is not an object is skipped (it would otherwise end the
      first board's detection);
    - a board whose /system_state cannot be fetched at all is not a
      Baldrick: it falls through every other detector and is listed as
      Unknown, with nothing of the Baldrick guess left on it.
    """
    old = {
        "/": page("<html><title>Baldrick Board</title></html>"),
        "/system_state": page({
            "board_model": "Baldrick 8 Port", "board_id": "24:6f:28:aa:bb:01",
            "ota": {"current_firmware_version": "v3.5.4"},
            "buddies": ["junk",
                        {"ip": "10.88.0.3", "board_id": "24:6F:28:AA:BB:03"},
                        {"ip": "10.88.0.4", "board_id": "24:6F:28:AA:BB:04"},
                        {"ip": "10.88.0.50", "board_id": "24:6F:28:AA:BB:50"}]}),
        "/settings": page({"hostname": "fake-baldrick"}),
    }
    new = {
        "/": page("<html><h1>Baldrick Board</h1></html>"),
        "/system_state": page({"ota": {"updatable": [
            {"name": "bootloader"}, "junk",
            {"name": "main", "current_firmware_version": "4.12.7"},
            {"name": "other", "current_firmware_version": "9.9.9"}]}}),
    }
    nodot = {
        "/": page("<html>Baldrick Board</html>"),
        "/system_state": page({"board_model": "Baldrick DMX", "ota": {"current_firmware_version": "v7"}}),
        "/settings": page({"hostname": "nodot-baldrick"}),
    }
    unreachable = {"/": page("<html>Baldrick Board</html>"), "/system_state": drop()}
    devices = {"10.88.0.2": old, "10.88.0.3": new, "10.88.0.4": TWINKLY,
               "10.88.0.5": nodot, "10.88.0.6": unreachable}
    keys = ("hostname", "type", "model", "version", "majorVersion", "minorVersion", "fppModeString")
    with fake_devices(devices):
        discover(fppd, devices)
        fppd.wait_for(lambda: systems(fppd)["10.88.0.3"]["uuid"] == "MAC:246F28AABB03",
                      timeout=5, what="the second board to take its identity from the first's buddies")
        got = systems(fppd)
        seen = {a: requests_seen(a) for a in ("10.88.0.2", "10.88.0.3")}

    assert fields(got["10.88.0.2"], *keys) == (
        "fake-baldrick", "Baldrick", "Baldrick 8 Port", "v3.5.4", 3, 5, "bridge"), got["10.88.0.2"]
    assert got["10.88.0.2"]["uuid"] == "MAC:246F28AABB01", got["10.88.0.2"]
    assert {"GET /system_state", "GET /settings"} <= set(seen["10.88.0.2"]), seen

    assert fields(got["10.88.0.3"], *keys) == (
        "10.88.0.3", "Baldrick", "Baldrick", "4.12.7", 4, 12, "bridge"), got["10.88.0.3"]
    assert "GET /settings" in seen["10.88.0.3"], seen

    assert got["10.88.0.4"]["uuid"] == "00000000-1111-2222-3333-444444444444", got["10.88.0.4"]
    assert "10.88.0.50" not in got, got["10.88.0.50"]

    assert fields(got["10.88.0.5"], *keys) == (
        "nodot-baldrick", "Baldrick", "Baldrick DMX", "v7", 0, 0, "bridge"), got["10.88.0.5"]

    assert fields(got["10.88.0.6"], "hostname", "type", "model", "version") == (
        "10.88.0.6", "Unknown System Type", "Unknown", "Unknown"), got["10.88.0.6"]


def hinkspix(info):
    return {"/": page("<html><title>HinksPix Config</title></html>"),
            "/XLights_BoardInfo.cgi": info}


def test_hinkspix_versions_come_from_the_board_info_cgi(fppd):
    """HinksPix controllers (a page titled "HinksPix Config") are listed as
    HinksPix in bridge mode, with the version built from
    /XLights_BoardInfo.cgi: each part's 3-character prefix stripped, as
    "MAIN:<MCPU>,POWER:<PCPU>,WIFI:<ECPU>,WEB:<WEB>", and the MCPU build
    number as the major version (minor 0).

    Also: only the parts present are listed; a value too short to carry a
    prefix is kept whole; a part of the wrong JSON type is left out; and
    without an MCPU (or without the CGI at all) the controller is still a
    HinksPix, with no version.
    """
    devices = {
        "10.88.0.2": hinkspix(page({"MCPU": "MS_123", "PCPU": "PS_45", "ECPU": "EZ_6", "WEB": "WF_78"})),
        "10.88.0.3": hinkspix(page({"MCPU": "MS_2104"})),
        "10.88.0.4": hinkspix(page({"MCPU": "12", "WEB": "WF_9"})),
        "10.88.0.5": hinkspix(page({"MCPU": "MS_7", "PCPU": {"x": 1}, "ECPU": ["EZ_1"], "WEB": "WF_3"})),
        "10.88.0.6": hinkspix(page({"PCPU": "PS_45", "WEB": "WF_78"})),
        "10.88.0.7": hinkspix(page("Not here", status=404)),
    }
    with fake_devices(devices):
        got = discover(fppd, devices)
        seen = requests_seen("10.88.0.2")
    assert "GET /XLights_BoardInfo.cgi" in seen, seen
    for a in devices:
        assert fields(got[a], "hostname", "type", "typeId", "model", "fppModeString") == (
            a, "HinksPix", 0xFD, "HinksPix", "bridge"), got[a]
    want = {
        "10.88.0.2": ("MAIN:123,POWER:45,WIFI:6,WEB:78", 123),
        "10.88.0.3": ("MAIN:2104", 2104),
        "10.88.0.4": ("MAIN:12,WEB:9", 12),
        "10.88.0.5": ("MAIN:7,WEB:3", 7),
        "10.88.0.6": ("Unknown", 0),
        "10.88.0.7": ("Unknown", 0),
    }
    for a, (version, major) in want.items():
        assert fields(got[a], "version", "majorVersion", "minorVersion") == (version, major, 0), got[a]


def experience(marker, state, **more):
    pages = {"/": page(f"<html>{marker}</html>"), "/api/state": page(state)}
    pages.update(more)
    return pages


def state(model, name, fw=None, network=None):
    v = {"system": {"controller_model": model, "controller_model_name": name}}
    if fw is not None:
        v["system"]["firmware_version"] = fw
    if network is not None:
        v["network"] = network
    return v


def test_experience_controllers_are_read_from_their_api(fppd):
    """Experience (Genius) controllers are recognised by any one of three page
    markers ("<title>Genius", "FriendlyNameBar()", "CurrentMonitoring()") and
    confirmed by /api/state. Each is listed as the generic "Genius Controller"
    type with controller_model_name as its model, and:

    - the 1.x firmware string "Genius_PRO_Controller_16 v1.3.1-2" gives
      version 1.3.1 (1.3), and /update/identity gives the identity
      "<hardware>-<id>";
    - "2.2.0-0" gives 2.2.0; with no identity endpoint the MAC comes from the
      state's network block, from the interface answering on the
      controller's own address (wifi here, though wired is listed first);
    - "2.10" gives 2.10 (2.10); an identity with no "hardware" is the bare id;
    - a firmware string with no dotted version is reported as sent (0.0); an
      empty id is no identity, and with no network block in the state the MAC
      comes from /api/current_state, the first interface when none is on
      the controller's address;
    - no firmware string at all leaves the version Unknown.

    Only the controller with nothing better asks /api/current_state.

    Not checked: fppModeString. The detector never sets bridge mode, so an
    Experience controller found only over HTTP is listed as "player" (see
    ~/PROBLEMS.md, 16).
    """
    devices = {
        "10.88.0.2": experience(
            "<title>Genius Pixel 16</title>",
            state("GP16", "Genius Pixel 16", "Genius_PRO_Controller_16 v1.3.1-2",
                  {"wired": {"mac_address": "AA:BB:CC:00:20:09", "ip_address": "10.88.0.2"}}),
            **{"/update/identity": page({"id": "0123ABCD", "hardware": "GP16"})}),
        "10.88.0.3": experience(
            '<div v-scope="FriendlyNameBar()"></div>',
            state("G16PRO", "Genius PRO 16", "2.2.0-0",
                  {"wired": {"mac_address": "AA:BB:CC:00:10:01", "ip_address": "192.168.1.9"},
                   "wifi": {"mac_address": "aa-bb-cc-00-10-02", "ip_address": "10.88.0.3"}})),
        "10.88.0.4": experience(
            '<div v-scope="CurrentMonitoring()"></div>',
            state("AC16", "LOR AURORA CORE 16", "2.10"),
            **{"/update/identity": page({"id": "XYZ-42"})}),
        "10.88.0.5": experience(
            "<title>Genius Long Range</title>",
            state("GLR", "Genius Long Range", "beta-build"),
            **{"/update/identity": page({"id": "", "hardware": "GLR"}),
               "/api/current_state": page({"network": {
                   "wired": {"mac_address": "aa:bb:cc:00:10:05", "ip_address": "192.168.7.7"},
                   "wifi": {"mac_address": "aa:bb:cc:00:10:06", "ip_address": "192.168.7.8"}}})}),
        "10.88.0.6": experience(
            "<title>Genius Pixel 8</title>",
            state("GP8", "Genius Pixel 8", network={"wired": {"mac_address": "AA:BB:CC:00:10:07"}})),
    }
    keys = ("type", "typeId", "model", "version", "majorVersion", "minorVersion", "uuid")
    with fake_devices(devices):
        got = discover(fppd, devices)
        seen = {a: requests_seen(a) for a in devices}
    want = {
        "10.88.0.2": ("Genius Pixel 16", "1.3.1", 1, 3, "GP16-0123ABCD"),
        "10.88.0.3": ("Genius PRO 16", "2.2.0", 2, 2, "MAC:AABBCC001002"),
        "10.88.0.4": ("LOR AURORA CORE 16", "2.10", 2, 10, "XYZ-42"),
        "10.88.0.5": ("Genius Long Range", "beta-build", 0, 0, "MAC:AABBCC001005"),
        "10.88.0.6": ("Genius Pixel 8", "Unknown", 0, 0, "MAC:AABBCC001007"),
    }
    for a, w in want.items():
        assert fields(got[a], *keys) == ("Genius Controller", 0xAF) + w, got[a]
        assert got[a]["hostname"] == a, got[a]
        assert "GET /api/state" in seen[a] and "GET /update/identity" in seen[a], seen[a]
    asked = {a for a in devices if "GET /api/current_state" in seen[a]}
    assert asked == {"10.88.0.5"}, seen


def test_a_page_that_only_looks_like_an_experience_controller_is_not_one(fppd):
    """Two devices that are not Experience controllers are listed as Unknown:

    - one with a Genius marker whose /api/state lacks controller_model_name
      (the state is what decides it);
    - one whose page says "Genius" but carries none of the three markers,
      though its /api/state is a valid one: it is never asked for it.
    """
    devices = {
        "10.88.0.2": experience("<title>Genius</title>", {"system": {"controller_model": "GP16"}}),
        "10.88.0.3": experience("<h1>Genius Pixel 16</h1>", state("GP16", "Genius Pixel 16", "2.2.0")),
    }
    with fake_devices(devices):
        got = discover(fppd, devices)
        seen = {a: requests_seen(a) for a in devices}
    for a in devices:
        assert fields(got[a], "hostname", "type", "model", "version") == (
            a, "Unknown System Type", "Unknown", "Unknown"), got[a]
    assert "GET /api/state" in seen["10.88.0.2"], seen
    assert "GET /api/state" not in seen["10.88.0.3"], seen


def test_a_new_vendor_reply_of_the_wrong_shape_is_no_match(fppd):
    """A Baldrick /system_state or an Experience /api/state with a field of
    the wrong JSON type (an object for a model name) can't be read, so the
    device is not claimed: it is listed as Unknown, and fppd carries on.
    """
    devices = {
        "10.88.0.2": {"/": page("<html>Baldrick Board</html>"),
                      "/system_state": page({"board_model": {"a": 1}})},
        "10.88.0.3": experience("<title>Genius</title>",
                                {"system": {"controller_model": "GP16", "controller_model_name": {}}}),
    }
    with fake_devices(devices):
        got = discover(fppd, devices)
    for a in devices:
        assert fields(got[a], "hostname", "type", "version") == (
            a, "Unknown System Type", "Unknown"), got[a]
