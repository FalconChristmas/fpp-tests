"""Command fixes from 10.1 and 10.2: replies and argument lists longer than
the buffers they were copied into."""

import json
import os
import time

from test_command_socket import send


def test_get_test_mode_with_a_long_config(fppd):
    """GetTestMode answers on the command socket with a test config longer
    than its 1501-byte reply buffer: the reply is cut short, fppd stays up.

    Regression: 0b742c0c9. The config, which SetTestMode takes from the API
    unbounded, was strcpy'd into the reply on the stack: an ASan
    stack-buffer-overflow."""
    fppd.start()
    config = {"enabled": 1, "mode": "SingleChase", "subMode": "RGBChase-RGB", "cycleMS": 500,
              "colorPattern": "FF000000FF000000FF", "channelSet": "1-30",
              "channelSetType": "channelRange", "note": "x" * 2000}
    on = json.dumps(config, separators=(",", ":"))
    assert len(on) > 2000
    assert "Test Mode Activated" in send("SetTestMode," + on)
    got = send("GetTestMode")
    assert got.startswith("{") and "SingleChase" in got.replace(" ", ""), got[:200]
    assert len(got) < 1501, len(got)
    send('SetTestMode,{"enabled":0}')


def test_run_script_with_more_arguments_than_it_passes(fppd):
    """Run Script with 200 arguments runs the script with the first ones
    (at most about 127) in order.

    Regression: 0537f1372. The forked child copied every argument into a
    char* args[128] on its stack: past 128 the child overwrote its stack
    (under ASan it died there) and the script never ran. RunScript was
    rewritten later (0cfa33573), so prove this one against 0537f1372's
    parent."""
    out = os.path.join(fppd.media, "tmp", "args.out")
    os.chmod(fppd.write("scripts/args.sh",
                        f'#!/bin/bash\necho "$#" "$@" > {out}.tmp && mv {out}.tmp {out}\n'), 0o755)
    fppd.start()
    args = " ".join(f"a{i}" for i in range(200))
    fppd.command("Run Script", "args.sh", args, "")
    fppd.wait_for(lambda: os.path.exists(out), timeout=15, what="the script to run")
    words = open(out).read().split()
    n = int(words[0])
    assert 100 <= n <= 200, n
    assert words[1:] == [f"a{i}" for i in range(n)], words[:5]
    time.sleep(0.5)
