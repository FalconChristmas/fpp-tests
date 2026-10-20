"""Versioned ETags on fppd's API: /commands answers a conditional request
with 304 from a version counter, without building its ~34 KB body."""

import urllib.error
import urllib.request

from fppd import API


def get(path, etag=None):
    """(status, ETag header, body) of a GET, If-None-Match `etag`."""
    req = urllib.request.Request(API + path)
    if etag:
        req.add_header("If-None-Match", etag)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers.get("ETag"), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("ETag"), e.read()


def test_commands_list_revalidates(fppd):
    """GET /commands carries an ETag; sending it back is a 304 with no
    body, any other tag gets the list, and a tag from before an fppd restart
    gets the list again (the counter starts over in a new process).

    Feature: e5dad1a01."""
    fppd.start()
    code, tag, body = get("/commands")
    assert code == 200 and tag and body.startswith(b"["), (code, tag, body[:60])
    code, again, body2 = get("/commands", tag)
    assert code == 304 and not body2, (code, body2[:60])
    assert again == tag
    code, _, body3 = get("/commands", '"0-0"')
    assert code == 200 and body3 == body
    rc = fppd.stop()
    assert rc == 0, rc
    fppd.start()
    code, newtag, body4 = get("/commands", tag)
    assert code == 200 and body4.startswith(b"["), code
    assert newtag != tag, "a tag from the last fppd still matches"
