"""Config files and JSON documents whose root is the wrong kind of value:
an array where an object belongs, or the reverse.

A backup restore is one way to get there (its decode-to-map round trip
turns an empty object into an empty array), a hand edit another. jsoncpp
throws Json::LogicError from operator[], isMember() and getMemberNames() on
a root of the other kind, and nothing in fppd catches it, so one such file
took fppd down at startup -- and again on every start after, with the file
still saved. (Fields of the wrong type inside a well-shaped root are
test_config_robustness.py's.)
"""

import os
import time

import pytest

from test_playlist_entries import dynamic, playlist, run, status, step

# file in config/ -> (the wrong-shaped content, the root it should have)
ROOTS = {
    "variables.json": ([{"value": "1"}], "object"),
    "ci-universes.json": ([{"type": "universes"}], "object"),
    "channeloutputs.json": ([{"type": "LEDPanelMatrix"}], "object"),
    "sensors.json": ([{"sensors": []}], "object"),
    "co-universes.json": ([{"type": "universes"}], "object"),
    "model-overlays.json": ([{"Name": "M"}], "object"),
    "commandPresets.json": ([{"name": "P"}], "object"),
    "gpio.json": ({"pin": "P1-7"}, "array"),
    "schedule.json": ({"enabled": 1}, "array"),
    "recurringtasks.json": ({"name": "T"}, "array"),
}


@pytest.mark.parametrize("name", list(ROOTS))
def test_a_config_file_with_the_wrong_root_is_logged_and_ignored(fppd, name):
    """fppd starts with the file saved, answers, and logs which file holds
    what instead of what it should.

    Regression: 8d3e0b418. LoadJsonFromFile() accepted any valid JSON, and
    the loader that read the file indexed its root at once: the throw
    terminated fppd as it started."""
    content, want = ROOTS[name]
    fppd.write(f"config/{name}", content)
    fppd.start()
    time.sleep(1)  # some loaders run after fppd first answers
    fppd.get("/fppd/status", timeout=10)
    fppd.check_alive()
    have = "object" if want == "array" else "array"
    said = [line for line in fppd.log().splitlines()
            if name in line and f"has a {have} at its root, expected {want}" in line]
    assert said, f"no log line naming {name}'s root:\n{fppd.log()[-3000:]}"


def test_a_null_variables_file_is_an_empty_one(fppd):
    """variables.json holding just null -- what Variables::save() writes
    when nothing is persisted -- loads as no variables, with no error, and
    variables set afterwards work.

    Regression: 0ad4cd5ae. 8d3e0b418's shape check counted null as a
    mismatch, so a stock install logged "has a null at its root" on every
    start."""
    fppd.write("config/variables.json", "null")
    fppd.start()
    assert fppd.get("/variables", timeout=10) in ({}, [], None)
    fppd.command("Set Variable", "v", "Value", "7")
    assert fppd.get("/variables", timeout=10)["v"]["value"] == "7"
    said = [line for line in fppd.log().splitlines() if "at its root" in line]
    assert not said, said


# A dynamic entry's JSON whose root, entry list or entries are of the wrong
# kind. Each is skipped (the entries that are objects still play).
DYNAMIC = {
    "root is a list": ([{"mainPlaylist": []}], "12"),
    "root is a number": (5, "12"),
    "an entry is a number": ({"mainPlaylist": [5, step(5)]}, "152"),
    "an entry is a list": ({"mainPlaylist": [[1], step(5)]}, "152"),
}


@pytest.mark.parametrize("what", list(DYNAMIC))
def test_dynamic_entry_json_of_the_wrong_shape(fppd, what):
    """A dynamic playlist entry whose file holds JSON of the wrong shape is
    skipped with a warning (or, for an entry of the wrong kind, that entry
    is), and the playlist carries on to the end.

    Regression: 3886b1784. ReadFromString() took any valid JSON and called
    isMember() on its root, then indexed each entry: the throw went up
    through the playlist's main-loop processing and terminated fppd."""
    content, want = DYNAMIC[what]
    path = fppd.write("tmp/dyn.json", content)
    fppd.write("playlists/P.json", playlist("P", main=[step(1), dynamic("file", dataFile=path), step(2)]))
    fppd.start()
    assert run(fppd, "P") == want
    warnings = status(fppd).get("warnings", [])
    assert any("Dynamic playlist" in w for w in warnings), warnings
    assert os.path.exists(path)
