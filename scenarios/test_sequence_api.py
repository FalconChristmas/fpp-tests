"""The web API's sequence controls: GET /api/sequence/:name/start/:second,
/api/sequence/current/togglePause, /step and /stop (sequence.php), which the
sequence test page uses. Each sends fppd a command over its local socket
(commandsocket.php's SendCommand()); what fppd then plays is read off a DDP
output."""

import json
import os
import re
import subprocess
import tempfile
import time

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import ddp_output, status

CHANNELS = 30
STEP_MS = 50

# The handlers taken out of the tree's sequence.php, and SendCommand() out of
# commandsocket.php, as they are, and run on their own (the rest of the API
# needs Apache), with the API's json() and params() and the files
# controller's findFile() standing in. argv: handler [SequenceName startSecond].
DRIVER = r"""<?php
$settings = ['Platform' => 'Linux', 'sequenceDirectory' => getenv('SEQ_DIR')];
function json($v) { return json_encode($v); }
function params($name) {
    global $argv;
    $p = ['SequenceName' => $argv[2] ?? null, 'startSecond' => $argv[3] ?? null];
    return $p[$name];
}
function findFile($dir, $f) { return file_exists($dir . '/' . $f) ? $f : false; }
$tree = getenv('FPP_TREE') . '/www';
foreach ([['/commandsocket.php', ['CleanupSocket', 'SendCommand']],
          ['/api/controllers/sequence.php', [$argv[1]]]] as [$file, $funcs]) {
    $src = file_get_contents($tree . $file);
    foreach ($funcs as $fn) {
        if (!preg_match('/^function ' . $fn . '\(.*?^}/ms', $src, $m)) {
            fwrite(STDERR, "$fn() not found in $file\n");
            exit(2);
        }
        eval($m[0]);
    }
}
echo $argv[1]();
"""


def api(fppd, path):
    """GET /api<path> as the API routes it: the handler index.php dispatches
    it to, run on its own."""
    with open(os.path.join(fppd.tree, "www", "api", "index.php")) as f:
        routes = f.read()
    args = []
    route = path
    m = re.fullmatch(r"/sequence/([^/]+)/start/(\d+)", path)
    if m:
        route, args = "/sequence/:SequenceName/start/:startSecond", list(m.groups())
    m = re.search(r"dispatch_get\('" + re.escape(route) + r"',\s*'(\w+)'\)", routes)
    assert m, f"index.php routes no GET for {route}"
    with tempfile.NamedTemporaryFile("w", suffix=".php", delete=False) as f:
        f.write(DRIVER)
    try:
        r = subprocess.run(["php", f.name, m.group(1), *args], capture_output=True, text=True,
                           timeout=30, env=dict(os.environ, FPP_TREE=fppd.tree,
                                                SEQ_DIR=os.path.join(fppd.media, "sequences")))
    finally:
        os.unlink(f.name)
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)
    assert got.get("status") == "OK", got
    return got


def index(frame):
    """The sequence frame (0-based) a received frame is: unique_frames puts
    its number, plus one, in the first three channels."""
    n = (frame[0] << 16) | (frame[1] << 8) | frame[2]
    return n - 1 if n else None


def test_sequence_api_start_at_a_second_pause_step_stop(fppd):
    """A 20 s sequence started through the API at second 5 plays from frame
    100 (50 ms frames), not from the top; togglePause holds it on one frame;
    step moves it on exactly one frame; stop ends it.

    Regression: 0414a9bc9. The API had no way to start a sequence at a
    given second, pause, step or stop it: the sequence test page did it
    through fppjson.php, and none of these routes existed."""
    frames = unique_frames(400, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Solo.fseq"), frames, step_ms=STEP_MS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        started = time.monotonic()
        got = api(fppd, "/sequence/Solo/start/5")
        assert got.get("startSecond") == "5", got
        fppd.wait_for(lambda: status(fppd).get("current_sequence") == "Solo.fseq", timeout=10,
                      what="the sequence to start")
        assert rx.wait_frames(1, since=started), "no frame from the sequence"
        first = [index(f) for _, f in rx.snapshot(since=started) if index(f) is not None]
        assert first and 95 <= first[0] <= 110, f"the first frames played: {first[:5]}"

        api(fppd, "/sequence/current/togglePause")
        time.sleep(0.5)
        paused = time.monotonic()
        assert rx.wait_frames(5, since=paused), "no frames while paused"
        held = {index(f) for _, f in rx.snapshot(since=paused)}
        assert len(held) == 1, f"a paused sequence moved on: {sorted(held)}"
        at = held.pop()

        api(fppd, "/sequence/current/step")
        fppd.wait_for(lambda: index(rx.last()) != at, timeout=5, what="the step")
        time.sleep(0.5)
        stepped = time.monotonic()
        assert rx.wait_frames(5, since=stepped), "no frames after the step"
        now = {index(f) for _, f in rx.snapshot(since=stepped)}
        assert now == {at + 1}, f"paused on frame {at}, after one step: {sorted(now)}"

        api(fppd, "/sequence/current/stop")
        fppd.wait_for(lambda: status(fppd).get("current_sequence", "") == "", timeout=10,
                      what="the sequence to stop")
