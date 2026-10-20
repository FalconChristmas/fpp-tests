"""ETags on fppd's large, rarely changing API answers: /commands, the overlay
effect list and the model list answer a conditional request with a bodiless
304 -- /commands and the model list from a version counter, without building
the body -- until what the tag versions changes or fppd restarts.

Features: e5dad1a01 (/commands), 75a29a548 and 41d1b62b9 (effects, models)."""

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


def assert_revalidates(path):
    """The route carries an ETag, answers it with a bodiless 304, and gives
    the body to any other tag. Returns the tag."""
    code, tag, body = get(path)
    assert code == 200 and body, f"{path}: {code}"
    assert tag, f"{path} carries no ETag"
    code, _, body = get(path, tag)
    assert code == 304 and body == b"", f"{path} sent the whole body again ({code}) for its own tag"
    assert get(path, '"fpp-tests"')[0] == 200
    return tag


def test_the_effect_list_revalidates(fppd):
    """/overlays/effects?full=true (~350 KB) answers its own tag with a 304,
    however a cache in between spelled the tag back: weak, with a -gzip
    suffix, or in a list. Another route's tag does not satisfy it.

    Feature: 75a29a548 (the effect list gets an ETag; it had none, with
    max-age=0, so every load sent the whole body). 41d1b62b9 versions it on
    the effect registrations, so the 304 skips building the list too."""
    fppd.start()
    path = "/overlays/effects?full=true"
    tag = assert_revalidates(path)
    bare = tag.strip('"')
    for spelled in (f'W/"{bare}"', f'"{bare}-gzip"', f'"fpp-tests", "{bare}"'):
        assert get(path, spelled)[0] == 304, f"{spelled} was not taken as the tag"
    assert get("/overlays/effects", tag)[0] == 200


def test_the_model_list_revalidates_and_a_restart_changes_its_tag(fppd):
    """/models answers its own tag with a 304; a tag for ?simple=true does not
    satisfy the plain route, and a tag from before fppd restarted does not
    satisfy the new fppd (its model-set counter starts over).

    Feature: 41d1b62b9 (version the model and effect lists so a 304 skips the
    build). Before it /models had no validator and sent every model on every
    load."""
    fppd.write("config/model-overlays.json", {"models": [{
        "Name": "fpp-tests-model", "Type": "Channel", "StartChannel": 1,
        "ChannelCount": 30, "ChannelCountPerNode": 3, "Orientation": "horizontal",
        "StartCorner": "TL", "StringCount": 1, "StrandsPerString": 1}]})
    fppd.start()
    tag = assert_revalidates("/models")
    simple = assert_revalidates("/models?simple=true")
    assert simple != tag
    assert get("/models", simple)[0] == 200, "a ?simple=true tag satisfied the full list"
    fppd.stop()
    fppd.start()
    code, _, body = get("/models", tag)
    assert code == 200 and b"fpp-tests-model" in body, "a tag from before the restart got a 304"
