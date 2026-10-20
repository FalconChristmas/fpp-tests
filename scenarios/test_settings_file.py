"""The media settings file (key = "value" lines) as fppd reads it at startup
and writes keys back into it, alongside the PHP side, which reads and writes
the same file."""

import os
import time

from show import status


def test_a_value_containing_an_equals_sign_is_read_whole(fppd):
    """A setting whose value contains "=" (a base64 password ending "==", a
    URL with a query) is read up to its closing quote, not to the "=".

    Regression: e4ada58de. The loader split each line on every "=", so the
    value ended at the first one in it: TimeFormat "A=%Y" read as "A"."""
    fppd.settings(TimeFormat="A=%Y")
    fppd.start()
    assert status(fppd)["timeStr"] == time.strftime("A=%Y")


def test_saving_a_key_leaves_a_longer_key_ending_in_it_alone(fppd):
    """Saving LogLevel_General (as setting a log level through the API does)
    rewrites that key's own line, not the line of a longer key that ends in
    the same text and comes first in the file.

    Regression: e4ada58de. The key was found by searching the file for
    "LogLevel_General = ", which matched inside "XLogLevel_General = ": that
    line was replaced and the real one left as it was."""
    fppd.settings(XLogLevel_General="keep", LogLevel_General="info")
    fppd.start()
    fppd.post("/fppd/log/level/debug")
    with open(os.path.join(fppd.media, "settings")) as f:
        lines = f.read().splitlines()
    assert 'XLogLevel_General = "keep"' in lines, lines
    assert 'LogLevel_General = "debug"' in lines, lines
