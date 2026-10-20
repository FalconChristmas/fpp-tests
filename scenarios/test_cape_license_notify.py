"""fppd telling a cape's vendor that the cape's signature verifies but is
not bound to this hardware -- a signed image lifted off the board it was
licensed to -- from its idle loop, once there is a network.

Cape detection (CapeUtils) marks that case in media/tmp/cape-info.json as
"licenseCheck"; the suite can't sign an image to make CapeUtils find one, so
these scenarios write the cape-info.json detection would have published.
"""

import http.server
import json
import os
import threading
import time
import urllib.parse

import pytest


class Vendor:
    """The cape vendor's server: records every request."""

    def __init__(self):
        self.requests = []
        vendor = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                vendor.requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def vendor():
    v = Vendor()
    try:
        yield v
    finally:
        v.close()


def unbound_cape(vendor, **vendor_fields):
    return {"id": "TestCape", "name": "Test Cape", "serialNumber": "TEST0001", "cs": "c5c5",
            "verifiedKeyId": "dk", "capeStatus": "SIGNED", "licenseCheck": True,
            "vendor": {"name": "fpp-tests", **vendor_fields}}


def test_an_unbound_cape_signature_is_reported_once(fppd, vendor):
    """fppd sends the vendor's licenseCheckUrl one request naming the cape
    (lc=1, id, sn, cs, key -- nothing else), logs that it did, and records
    it, so a restart doesn't send it again.

    Feature: 5605f6aed. Before it, this case was "reported" by deleting
    the user's FetchVendorLogos setting so the logo request carried the
    serial instead.
    """
    fppd.write("tmp/cape-info.json", unbound_cape(vendor, licenseCheckUrl=f"{vendor.url}/lc",
                                                  image=f"{vendor.url}/logo.png"))
    fppd.start()
    fppd.wait_for(lambda: vendor.requests, timeout=30, what="a request to the cape vendor")
    path, _, query = vendor.requests[0].partition("?")
    assert path == "/lc", vendor.requests
    assert urllib.parse.parse_qs(query) == {"lc": ["1"], "id": ["TestCape"], "sn": ["TEST0001"],
                                             "cs": ["c5c5"], "key": ["dk"]}, vendor.requests
    fppd.wait_for(lambda: "notifying the cape vendor" in fppd.log(), timeout=10, what="the log line")
    state_file = os.path.join(fppd.media, "config", "cape_license_state.json")
    fppd.wait_for(lambda: os.path.exists(state_file), timeout=10, what="the delivery to be recorded")
    with open(state_file) as f:
        assert json.load(f).get("lastSuccess"), "the delivery was not recorded"

    assert fppd.stop() == 0
    fppd.start()
    time.sleep(8)
    assert len(vendor.requests) == 1, f"reported again after a restart: {vendor.requests}"


def test_a_bound_cape_is_never_reported(fppd, vendor):
    """A cape without the licenseCheck marker -- every cape on its own
    EEPROM -- sends nothing, though it names a vendor URL.

    Feature: 5605f6aed.
    """
    info = unbound_cape(vendor, licenseCheckUrl=f"{vendor.url}/lc")
    del info["licenseCheck"]
    fppd.write("tmp/cape-info.json", info)
    fppd.start()
    time.sleep(8)
    assert vendor.requests == [], vendor.requests
