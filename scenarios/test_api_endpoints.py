"""fppd's own REST endpoints: what they answer, what they refuse and how
large a request they take."""

import json
import os
import re
import urllib.error


def call(fppd, method, path, body=None):
    """(HTTP status, decoded body) of one request to fppd."""
    try:
        return 200, fppd.request(method, path, body, timeout=30)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.body)
        except ValueError:
            return e.code, e.body


def levels(fppd):
    """Every logger's level, from GET /fppd/log."""
    return fppd.get("/fppd/log").get("log", {})


def saved_levels(fppd):
    """The LogLevel_* settings in the media settings file."""
    with open(os.path.join(fppd.media, "settings")) as f:
        return dict(re.findall(r'^(LogLevel_\w+) = "(.*)"$', f.read(), re.M))


def test_a_post_that_succeeds_answers_its_result(fppd):
    """A POST to an /fppd endpoint that did its work answers 200 with that
    endpoint's own result.

    Regression: c4b11629b. render_POST() checked the result for a "status"
    member, but every helper sets "Status", so each POST under /fppd -- the
    log level the Logging settings page sets among them -- did its work and
    then answered 400 "POST endpoint helper did not set result JSON"."""
    fppd.start()
    code, body = call(fppd, "POST", "/fppd/log/level/debug")
    assert code == 200, body
    assert body.get("Status") == "OK", body
    # The control: the request did what it asked.
    assert set(levels(fppd).values()) == {"debug"}, levels(fppd)


def test_an_unknown_log_level_is_refused_and_changes_nothing(fppd):
    """POST /fppd/log/level/<level> refuses a level it does not know with a
    400, changing no logger and saving nothing; a level:channel form it does
    know is applied and saved to the LogLevel_* settings, which is what the
    Logging settings page reads back.

    Regression: 1178c4b79. Any level answered "Log Level Updated", including
    one that SetLogLevelComplex() had rejected and changed nothing for, and a
    level that was applied was not saved, so the settings page and the next
    start did not see it."""
    fppd.start()
    before = levels(fppd)
    assert before, fppd.get("/fppd/log")
    saved = saved_levels(fppd)

    for bogus in ("bogus", "bogus:Schedule"):
        code, body = call(fppd, "POST", f"/fppd/log/level/{bogus}")
        assert code == 400, f"{bogus}: {code} {body}"
        assert levels(fppd) == before, bogus
        assert saved_levels(fppd) == saved, bogus

    # The control: a level it knows, for one channel.
    channel = "Schedule" if "Schedule" in before else sorted(before)[0]
    code, body = call(fppd, "POST", f"/fppd/log/level/debug:{channel}")
    assert code == 200, body
    assert levels(fppd)[channel] == "debug", levels(fppd)
    assert saved_levels(fppd).get(f"LogLevel_{channel}") == "debug", saved_levels(fppd)

    # The receiving end of the saved level: the next start uses it.
    assert fppd.stop() == 0
    fppd.start()
    assert levels(fppd)[channel] == "debug", levels(fppd)


def test_a_model_overlays_upload_over_1mb_is_taken(fppd):
    """POST /models takes a model-overlays.json bigger than a megabyte and
    saves it whole.

    Regression: f4420bff4. Drogon's default 1 MB request body limit was never
    raised, so a large model-overlays.json upload was refused (413) with
    nothing saying why. Then fppd restarts on the saved file and has those
    models, as a player does after the upload's restart flag."""
    fppd.start()
    # Each model carries a field fppd ignores, to make the file big without
    # making fppd load thousands of models.
    models = [{"Name": f"fpp-tests-model-{i:03d}", "Type": "Channel", "StartChannel": 1 + i * 30,
               "ChannelCount": 30, "ChannelCountPerNode": 3, "Orientation": "horizontal",
               "StartCorner": "TL", "StringCount": 1, "StrandsPerString": 1,
               "fppTestsPadding": "x" * 8000}
              for i in range(300)]
    body = json.dumps({"models": models}, indent=4).encode()
    assert len(body) > 2 * 1024 * 1024, len(body)
    try:
        code, reply = call(fppd, "POST", "/models", body)
    except urllib.error.URLError as e:
        # Drogon answers 413 and closes the connection while the body is
        # still being sent.
        code, reply = "refused", e
    assert code == 200, f"{code} {str(reply)[:300]}"
    with open(os.path.join(fppd.media, "config", "model-overlays.json"), "rb") as f:
        assert f.read() == body, "model-overlays.json is not the uploaded file"

    # The receiving end: fppd reads models at start, and starts with these.
    assert fppd.stop() == 0
    fppd.start()
    names = {m["Name"] for m in fppd.get("/models")}
    assert names == {m["Name"] for m in models}, sorted(names)[:5]
