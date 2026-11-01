"""HTTP discovery of a controller whose front page is an HTTP/0.9 reply."""

from fake_devices import fake_devices, page, raw
from test_controller_detection import discover


def test_a_controller_answering_in_http_0_9_is_still_identified(fppd):
    """Some older controllers answer the front page with a bare body and no
    status line or headers. curl refuses that unless told to allow it, and a
    refused page leaves the controller undetected.

    Regression: f8e749983. Discovery set no HTTP/0.9 allowance, so a Falcon
    whose page came back that way was never found. Master's probe still sets
    it for the same reason.
    """
    old = {
        "/": raw('<html><link href="css/falcon.css"></html>'),
        "/status.xml": page("<status><p>128</p><np>16</np><fv>2.0 4</fv><n>old-falcon</n></status>",
                            ctype="text/xml"),
    }
    with fake_devices({"10.88.0.3": old}):
        got = discover(fppd, {"10.88.0.3": old})
    assert got["10.88.0.3"]["hostname"] == "old-falcon" and "F16" in got["10.88.0.3"]["type"], got["10.88.0.3"]
