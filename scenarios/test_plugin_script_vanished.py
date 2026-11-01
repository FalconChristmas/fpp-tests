"""A plugin whose script disappears while fppd runs (uninstalled behind its
back): fppd's forked child fails to exec it and must go away without
running fppd's exit handlers."""

import os
import time

from test_plugin_scripts import plugin


def test_a_vanished_plugin_command_script_fails_quietly(fppd):
    """With a plugin command's script deleted under a running fppd, running
    the command returns, logs no line twice, produces no sanitizer report
    (the conftest check) and leaves fppd answering.

    Regression: 502ffc3e1. The child of the failed exec called exit(), which
    ran fppd's atexit handlers and destructors in a copy of its address
    space (stack traces in the log, leak reports under a sanitizer); it
    now calls _exit()."""
    d = plugin(fppd, extra={
        "commands/descriptions.json": [{"name": "Test Plugin Gone", "script": "gone.sh", "args": []}],
        "commands/gone.sh": "#!/bin/sh\ntrue\n",
    })
    fppd.start()
    os.remove(os.path.join(d, "commands", "gone.sh"))
    for _ in range(3):
        fppd.command("Test Plugin Gone")
    time.sleep(1)
    assert fppd.get("/fppd/status"), "fppd stopped answering"
    seen = {}
    for line in fppd.log().splitlines():
        if line[:4].isdigit() and "Running command" not in line:
            seen[line] = seen.get(line, 0) + 1
    assert not [l for l, n in seen.items() if n > 1], "a line was logged twice"
    rc = fppd.stop()
    fppd.exit_expected = True
    assert rc == 0, f"fppd exited {rc}"
