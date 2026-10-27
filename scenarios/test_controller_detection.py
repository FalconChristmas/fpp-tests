"""Controller detection: fppd's HTTP discovery probes the addresses in
MultiSyncHTTPSubnets, reads each front page, asks the device's own API where
the vendor has one, and lists what it found in /fppd/multiSyncSystems.

The devices are fakes in their own network namespace (fake_devices.py),
answering with the pages and API replies each vendor's detector looks for.
"""

import json
import time

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
    """One device of each vendor is listed with its name, type, version and
    identity: an FPP's own UUID, a Falcon's and a WLED's MAC from their APIs
    (dfa5b5b7a), a Twinkly from its gestalt (2babf4d5c), a SanDevices' MAC
    from its page (38cfc76e9), and anything else as Unknown.

    Feature: 2babf4d5c, 38cfc76e9, dfa5b5b7a.
    """
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


def test_two_devices_reporting_one_uuid_raise_no_warning(fppd):
    """Two FPPs at different addresses and with different names that report
    the same UUID from their API are both listed with it, and no
    duplicate-UUID warning is raised.

    Regression: f4cfc26c2. UpdateSystem() raised warning 57 ("Duplicate
    System UUID detected") whenever two names shared a UUID. The check was
    removed: a device that changed its hostname or address was reported as
    a duplicate of itself, and the warning's id is the plugin-reinstall
    warning's.
    """
    def fpp(name):
        info = dict(json.loads(FPP["/api/system/info"]["body"]), HostName=name)
        return {"/": FPP["/"], "/api/system/info": page(info)}
    devices = {"10.88.0.2": fpp("twin-a"), "10.88.0.3": fpp("twin-b")}
    with fake_devices(devices):
        got = discover(fppd, devices)
        time.sleep(2)
        warnings = fppd.get("/fppd/status").get("warningInfo", [])
    assert got["10.88.0.2"]["uuid"] == got["10.88.0.3"]["uuid"] == "M1-fake-fpp-uuid", got
    dup = [w for w in warnings if "UUID" in w.get("message", "")]
    assert not dup, f"a duplicate-UUID warning was raised: {dup}"


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


def vm_rss_mb(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 0


@pytest.mark.parametrize("subnets", ["10.0.0.0/8", "10.77.0.[1-100000000]"])
def test_a_huge_discovery_range_is_bounded(fppd, subnets):
    """An HTTP discovery range far larger than any show network -- a /8, or
    an octet range running to 10^8 -- is refused or clamped at startup, and
    fppd reaches its main loop without its memory running away. A watchdog
    kills fppd (failing the test) if its RSS passes 600 MB first.

    Regression: 344019a8a. Every address was expanded into a set of strings,
    then copied: 16.7M strings for the /8 and a 10^8 iteration loop for the
    range, on every start, until fppd ran out of memory.
    """
    import threading
    limit_mb = 600
    peak = {"mb": 0, "killed": False}
    done = threading.Event()

    def watch():
        while not done.is_set() and fppd.proc is None:
            time.sleep(0.01)
        while not done.is_set() and fppd.proc.poll() is None:
            peak["mb"] = max(peak["mb"], vm_rss_mb(fppd.proc.pid))
            if peak["mb"] > limit_mb:
                peak["killed"] = True
                fppd.kill()
                return
            time.sleep(0.1)

    fppd.settings(MultiSyncHTTPSubnets=subnets)
    watchdog = threading.Thread(target=watch, daemon=True)
    watchdog.start()
    try:
        fppd.start()
        fppd.wait_for(lambda: "Starting main processing loop" in fppd.log(), timeout=30,
                      interval=0.2, what="fppd to reach its main loop")
        time.sleep(2)
        fppd.check_alive()
    except Exception:
        if peak["killed"]:
            raise AssertionError(f"fppd's RSS passed {limit_mb} MB expanding {subnets}")
        raise
    finally:
        done.set()
        watchdog.join()
    assert not peak["killed"], f"fppd's RSS passed {limit_mb} MB expanding {subnets}"
    if "/" in subnets:
        assert "only /16 to /32 can be scanned" in fppd.log()



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

    Feature: f6a283460 (the board's own id), dfa5b5b7a (buddies). Regression:
    f921827d9 (version from ota.updatable, hostname from /settings).
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

    Feature: 4e24b6dd1. Regression: 107d8efe8 -- the parts were read with
    asString(), which throws on the object and the list at 10.88.0.5; checked
    by restoring those reads on the current tree, where (since 9c5cd05f9
    CurlManager catches the throw) that board is listed as Unknown instead of
    fppd dying.
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

    Only the controller with nothing better asks /api/current_state. Each is
    listed in bridge mode: HTTP can't tell, and one running as a player says
    so in its own MultiSync pings, which win.

    Feature: c95af2370 (detection), b322335a7 (MAC over HTTP). Regression:
    928d686cd (the 2.x version string), 863142972 (the detector never set
    bridge mode, so an Experience controller found only over HTTP was listed
    as "player").
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
    keys = ("type", "typeId", "model", "version", "majorVersion", "minorVersion", "uuid",
            "fppModeString")
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
        assert fields(got[a], *keys) == ("Genius Controller", 0xAF) + w + ("bridge",), got[a]
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


def test_twinkly_discovery_replies_are_bounded(fppd):
    """Replies to fppd's Twinkly discovery broadcast are taken only for a
    few seconds after it, and from at most 128 addresses: 300 hosts that
    answer at once get at most 128 HTTP probes between them, and 20 that
    answer 8 s later get none.

    Regression: 039dec22b. 4be58fb6a put the replies' probes under the
    in-flight cap, but the discovery socket stays open for the life of
    fppd, and its port is in every broadcast: each new source address that
    sent a 7-byte "OK" datagram, at any time, added an entry to the seen
    set, the pending set and the HTTP probe queue, and got a probe, with no
    bound. A flood of them pushed the periodic re-probes of real remotes
    behind thousands of fake ones.

    Also covers 2babf4d5c: the discovery broadcast itself, and a probe for
    the lights that answer it.
    """
    import os
    import subprocess
    import sys
    import threading
    from fake_devices import DEV_IF, HOST_ADDR, HOST_IF, NETNS, _ip, device_network

    first = [f"10.89.{i // 200}.{i % 200 + 1}" for i in range(300)]
    second = [f"10.89.3.{i + 1}" for i in range(20)]
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "twinkly_replies.py")
    with device_network(["10.88.0.2"]) as run:
        # fppd sends its discovery to each interface's broadcast address
        for args, ns in ((("addr", "del", HOST_ADDR + "/24", "dev", HOST_IF), None),
                         (("addr", "add", HOST_ADDR + "/24", "brd", "+", "dev", HOST_IF), None),
                         (("route", "add", "10.89.0.0/16", "dev", HOST_IF), None),
                         (("addr", "add", "10.88.0.3/24", "brd", "+", "dev", DEV_IF), NETNS)):
            r = _ip(*args, ns=ns)
            assert r.returncode == 0, f"ip {' '.join(args)}: {r.stderr}"
        batch = "".join(f"addr add {a}/16 dev {DEV_IF}\n" for a in first + second)
        r = subprocess.run(["ip", "-n", NETNS, "-batch", "-"], input=batch, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        proc = run(sys.executable, "-I", script, ",".join(first), ",".join(second), "8")
        lines = []

        def read():
            for line in proc.stdout:
                lines.append(line)
        threading.Thread(target=read, daemon=True).start()
        fppd.wait_for(lambda: "ready\n" in lines, what="the fake lights to listen")
        fppd.start()
        fppd.wait_for(lambda: any(line.startswith("port") for line in lines), timeout=30,
                      what="fppd's Twinkly discovery broadcast")
        fppd.wait_for(lambda: "sent\n" in lines, timeout=20, what="the late replies")
        time.sleep(8)
    probed = {line.split()[1] for line in lines if line.startswith("probe ")}
    early = probed & set(first)
    late = probed & set(second)
    assert early, "no reply got a probe: the discovery replies never reached fppd"
    assert len(early) <= 128, f"{len(early)} of {len(first)} replying hosts were probed"
    assert not late, f"{len(late)} hosts that replied 8 s after the broadcast were probed"
