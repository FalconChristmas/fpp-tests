"""What a freshly started (or quick-restarted) fppd shows the UI: the log
level it logs at with nothing configured, the fpp-info.json the UI watches
to see a restart finish, and the mode name it reports for a system whose
mode it does not know.
"""

import os

from multisync import ping_packet
from test_command_socket import send as command
from test_multisync_systems import interface, send, wait_listed

INFO_LINE = "Creation of Scheduler, Playlist, and Sequence Complete"
LOOP_LINE = "Starting main processing loop"


def test_default_log_level_is_info(fppd):
    """With no LogLevel settings at all, every logger is at info -- the
    level the Logging settings page shows as the default -- and fppd's Info
    lines are in fppd.log.

    Regression: 16dcb43c4. The built-in default was warn, so a box whose
    settings named no log level logged less than the UI said it would, and
    none of its Info lines."""
    with open(os.path.join(fppd.media, "settings")) as f:
        assert "LogLevel" not in f.read()
    fppd.start()
    levels = fppd.get("/fppd/log").get("log", {})
    assert levels and set(levels.values()) == {"info"}, levels
    fppd.wait_for(lambda: INFO_LINE in fppd.log(), timeout=10,
                  what=f"the Info line {INFO_LINE!r} in fppd.log")
