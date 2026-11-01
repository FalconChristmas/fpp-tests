"""How fppd reports its sequence buffer's memory."""

import os


def test_huge_page_messages_go_to_the_log_not_stdout(fppd):
    """fppd allocates its sequence buffer from 2 MB huge pages when it can
    and says which it got in the log at debug level; it prints nothing about
    it on stdout.

    Regression: 87b156be2. The huge page messages were printf()s, so every
    start put "Not using Huge Pages for Sequence Data" (and a "trying 2MB"
    line for the 64K attempt) on stdout, and none in the log."""
    fppd.settings(LogLevel_Sequence="debug")
    fppd.start()
    with open(os.path.join(fppd.media, "logs", "fppd.stdout"), errors="replace") as f:
        out = f.read()
    assert "Huge Pages" not in out, f"fppd printed about huge pages on stdout: {out!r}"
    fppd.wait_for(lambda: "Huge Pages for Sequence Data" in fppd.log(), timeout=5,
                  what="the huge page message in the log")
