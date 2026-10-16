"""Controller detection: fppd's HTTP discovery probes the addresses in
MultiSyncHTTPSubnets, reads each front page, asks the device's own API where
the vendor has one, and lists what it found in /fppd/multiSyncSystems.

The devices are fakes in their own network namespace (fake_devices.py),
answering with the pages and API replies each vendor's detector looks for.
"""

import pytest

from fake_devices import fake_devices, page

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
