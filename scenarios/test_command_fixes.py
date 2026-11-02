"""Command fixes from 10.1 and 10.2: replies and argument lists longer than
the buffers they were copied into, and the command socket's StartSequence
with a name it refuses."""

import json
import os
import socket
import time

from fseq import unique_frames, write_fseq
from multisync import PORT, sync_packet
from show import CHANNELS, ddp_output, status
from test_command_socket import send


def test_get_test_mode_with_a_long_config(fppd):
    """GetTestMode answers on the command socket with a test config longer
    than its 1501-byte reply buffer: the reply is cut short, fppd stays up.

    Regression: 0b742c0c9. The config, which SetTestMode takes from the API
    unbounded, was strcpy'd into the reply on the stack: an ASan
    stack-buffer-overflow. Proved by reverting 0b742c0c9 on master: at the
    fix and its parent the command socket times out on a SetTestMode this
    long, so verify-fix fails on both sides before GetTestMode is sent.

    Also bba2b2912: the command buffer was 256 bytes; with it back at 256 the
    SetTestMode above is cut short and answers "Test Mode Deactivated"."""
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


def test_start_sequence_with_a_refused_name_starts_nothing(fppd):
    """StartSequence on the command socket with a name the open refuses (a
    ../ path) starts nothing, even on a remote holding a sequence its master
    has opened but not started: that one stays idle until the master's
    start, and SEQUENCE_STARTED runs once, then.

    Regression: 70915ca9a. The handler started whatever sequence was open
    without checking its own open, so the remote's prepared sequence started
    early -- status "playing", SEQUENCE_STARTED run -- for a request naming
    another file."""
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), unique_frames(400, CHANNELS))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/commandPresets.json", {"commands": [
        {"name": "SEQUENCE_STARTED", "command": "Set Variable",
         "args": ["started", "Increment", "", "1", "0", "100", ""], "presetSlot": 0}]})
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    fppd.start()

    def started():
        v = (fppd.get("/variables") or {}).get("started", {}).get("value")
        return int(float(v)) if v not in (None, "") else 0

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.sendto(sync_packet("open", "fseq", 0, 0, "Show.fseq"), ("127.0.0.1", PORT))
        time.sleep(1)
        send("StartSequence,../Missing.fseq,0")
        time.sleep(1.5)  # presets run from the main loop
        s = status(fppd)
        assert s.get("status_name") == "idle", \
            f"after a refused name: {s.get('status_name')} {s.get('current_sequence')!r}"
        assert started() == 0, "SEQUENCE_STARTED ran for a request that started nothing"
        sock.sendto(sync_packet("start", "fseq", 0, 0, "Show.fseq"), ("127.0.0.1", PORT))
        fppd.wait_for(started, timeout=5, what="SEQUENCE_STARTED for the master's start")
        time.sleep(1)
        assert started() == 1, f"SEQUENCE_STARTED ran {started()} times"
        sock.sendto(sync_packet("stop", "fseq", 0, 0, "Show.fseq"), ("127.0.0.1", PORT))
    finally:
        sock.close()
