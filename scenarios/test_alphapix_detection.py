"""AlphaPix controllers in fppd's HTTP discovery: recognised from their
status page, typed from the model it names, with the version where it can
be read and the identity encoded in the Device ID it shows.

The boards are fakes in their own network namespace (fake_devices.py),
like those in test_controller_detection.py.
"""

from fake_devices import fake_devices, page
from test_controller_detection import discover, fields
from test_multisync_identity import device_mac


def alphapix(body):
    return {"/": page(f"<html><body>{body}</body></html>")}


VERSION = "Currently Installed Firmware Version:  1.08"


def test_alphapix_boards_are_listed_whatever_their_page_names(fppd):
    """Each of these is listed as an AlphaPix in bridge mode:

    - a page naming the model "AlphaPix 16": model "16", version 1.08;
    - a page naming it only as "4 Port Ethernet to SPI Controller": model "4";
    - a newer layout that names the model ("AlphaPix Flex") but states its
      version some other way: model "Flex", no version;
    - the stub page a board serves while another client holds its one web
      session (no model, no version): listed as a plain AlphaPix.

    Regression: 2d1ed2c75. The model was read from the first pattern's
    match even when only the second had matched (an empty type), a page
    whose version could not be read was not an AlphaPix at all, and the
    session stub matched nothing -- the last two boards vanished from
    discovery.

    Also 13456ff06: the patterns were searched with no match results to
    fill, and the model was then read from those empty results (SIGSEGV in
    sub_match::str on the first AlphaPix page).
    """
    devices = {
        "10.88.0.2": alphapix(f"<h1>AlphaPix 16 Controller</h1><p>{VERSION}</p>"),
        "10.88.0.3": alphapix(f"<h1>4 Port Ethernet to SPI Controller</h1><p>{VERSION}</p>"),
        "10.88.0.4": alphapix("<h1>AlphaPix Flex</h1><div class='fw'>Firmware 2.16</div>"),
        "10.88.0.5": alphapix("<p>Existing user login detected. Please try again later.</p>"),
    }
    keys = ("hostname", "type", "model", "fppModeString")
    with fake_devices(devices):
        got = discover(fppd, devices)
    want = {
        "10.88.0.2": ("16", "1.08", 1, 8),
        "10.88.0.3": ("4", "1.08", 1, 8),
        "10.88.0.4": ("Flex", "Unknown", 0, 0),
        "10.88.0.5": ("AlphaPix", "Unknown", 0, 0),
    }
    for a, (model, version, major, minor) in want.items():
        assert fields(got[a], *keys) == (a, "AlphaPix", model, "bridge"), got[a]
        assert fields(got[a], "version", "majorVersion", "minorVersion") == (version, major, minor), got[a]


def test_an_alphapix_is_identified_by_its_device_id(fppd):
    """The Device ID an AlphaPix shows is the low 24 bits of its MAC in
    decimal (zero OUI): 1193046 is listed as MAC:000000123456, whatever MAC
    the board answers ARP with. A Device ID too large to be 24 bits is no
    identity (the board keeps the one the ARP table gives it).

    Regression: 923fabebe. Before it the board's only identity was the ARP
    table's, which a board behind a router doesn't have.
    """
    devices = {
        "10.88.0.2": alphapix(f"<h1>AlphaPix 16</h1><p>{VERSION}</p><p>Device ID: 1193046</p>"),
        "10.88.0.3": alphapix(f"<h1>AlphaPix 4</h1><p>{VERSION}</p><p>Device ID: 99999999</p>"),
    }
    with fake_devices(devices):
        got = discover(fppd, devices)
        mac = device_mac()
    assert got["10.88.0.2"]["uuid"] == "MAC:000000123456", got["10.88.0.2"]
    assert got["10.88.0.3"]["uuid"] == "MAC:" + mac, got["10.88.0.3"]
