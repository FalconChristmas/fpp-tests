"""setSetting in scripts/common, replacing a setting that is already in the
settings file."""

import os
import time

from test_script_settings_lock import common


def test_set_setting_replaces_an_existing_value_without_waiting_on_itself(fppd):
    """setSetting on a key that is already in the settings file replaces it,
    at once and with one line left, and says nothing about a lock.

    Regression: 4f5ec95a8. It read the old value with getSetting, which
    takes a shared lock on the file setSetting already holds exclusively
    (through another open of it, as the read ran in a $(...) subshell): the
    read waited out the five-second timeout and warned "still locked after
    5s" before the value was replaced."""
    fppd.settings(FppTestsKey="old-value")
    fppd.start()
    path = os.path.join(fppd.media, "settings")

    began = time.monotonic()
    done = common(fppd, "setSetting FppTestsKey new-value")
    took = time.monotonic() - began

    with open(path) as f:
        lines = [l.strip() for l in f if l.startswith("FppTestsKey")]
    assert lines == ['FppTestsKey = "new-value"'], lines
    assert "still locked" not in done.stderr, done.stderr
    assert took < 3, f"setSetting waited {took:.1f}s on its own lock"


def test_set_setting_replaces_a_value_that_was_written_without_quotes(fppd):
    """setSetting on a key whose existing line has no quotes around the value
    (a hand-edited settings file) replaces that line, leaving one.

    Regression: 465988f5b. The delete pattern required the opening quote of
    the value, so an unquoted line was never deleted and the new value was
    appended after it, leaving the key twice."""
    fppd.settings(FppTestsKey="old-value")
    fppd.start()
    path = os.path.join(fppd.media, "settings")
    with open(path) as f:
        text = f.read().replace('FppTestsKey = "old-value"', "FppTestsKey = old-value")
    assert "FppTestsKey = old-value" in text, text
    with open(path, "w") as f:
        f.write(text)

    done = common(fppd, "setSetting FppTestsKey new-value")

    with open(path) as f:
        lines = [l.strip() for l in f if l.startswith("FppTestsKey")]
    assert lines == ['FppTestsKey = "new-value"'], (lines, done.stderr)
