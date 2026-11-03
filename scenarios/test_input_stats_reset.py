"""Resetting the network input statistics from the web API: DELETE
/api/channel/input/stats, which the input stats page's Reset button calls,
is channel_input_delete_stats() in channel.php passing the DELETE on to
fppd's /fppd/e131stats."""

import json
import os
import re
import subprocess
import tempfile

from packets import ARTNET_PORT, DDP_PORT, E131_PORT, artdmx, ddp, e131, send
from test_bridge_inputs import ARTNET_SIZE, ARTNET_UNIVERSE, E131_SIZE, setup, stats

# channel_input_delete_stats() taken out of the tree's channel.php as it is
# and run on its own (the rest of the controller needs Apache), with the
# API's json() helper standing in, and -- php-curl isn't installed in the
# scenario image -- the curl calls it makes done with PHP's own HTTP stream,
# by the method and to the URL it sets.
DRIVER = r"""<?php
function json($v) { return json_encode($v); }
if (!function_exists('curl_init')) {
    function curl_init($url = null) { return (object) ['url' => $url, 'method' => 'GET']; }
    function curl_setopt($ch, $opt, $val) {
        if ($opt === CURLOPT_URL) { $ch->url = $val; }
        if ($opt === CURLOPT_CUSTOMREQUEST) { $ch->method = $val; }
        return true;
    }
    function curl_exec($ch) {
        $ctx = stream_context_create(['http' => ['method' => $ch->method, 'timeout' => 5]]);
        return @file_get_contents($ch->url, false, $ctx);
    }
    function curl_close($ch) {}
    define('CURLOPT_URL', 10002);
    define('CURLOPT_CUSTOMREQUEST', 10036);
    define('CURLOPT_RETURNTRANSFER', 19913);
    define('CURLOPT_FAILONERROR', 45);
    define('CURLOPT_CONNECTTIMEOUT_MS', 156);
}
$src = file_get_contents(getenv('FPP_TREE') . '/www/api/controllers/channel.php');
if (!preg_match('/^function channel_input_delete_stats\(\).*?^}/ms', $src, $m)) {
    fwrite(STDERR, "channel_input_delete_stats() not found\n");
    exit(2);
}
eval($m[0]);
echo channel_input_delete_stats();
"""


def api_delete_stats(fppd):
    """DELETE /api/channel/input/stats as the API routes it: the handler
    index.php dispatches it to, run on its own."""
    with open(os.path.join(fppd.tree, "www", "api", "index.php")) as f:
        routes = f.read()
    m = re.search(r"dispatch_delete\('/channel/input/stats',\s*'(\w+)'\)", routes)
    assert m, "index.php routes no DELETE for /channel/input/stats"
    assert m.group(1) == "channel_input_delete_stats", m.group(0)
    with tempfile.NamedTemporaryFile("w", suffix=".php", delete=False) as f:
        f.write(DRIVER)
    try:
        r = subprocess.run(["php", f.name], capture_output=True, text=True, timeout=30,
                           env=dict(os.environ, FPP_TREE=fppd.tree))
    finally:
        os.unlink(f.name)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_api_reset_zeroes_the_e131_ddp_and_artnet_counters(fppd):
    """E1.31, Art-Net and DDP packets counted in the input stats, then
    DELETE /api/channel/input/stats: it answers "Stats Cleared", and every
    count is back to zero -- the E1.31 and Art-Net universes read 0 packets,
    0 bytes and 0 errors, and the DDP row (listed once DDP bytes arrive) is
    gone.

    Regression: dd33ea67b. There was no way to reset the counters short of
    restarting fppd: the API had no DELETE for the input stats, and fppd's
    DELETE handler had nothing behind it."""
    setup(fppd)
    fppd.start()
    data = bytes([0x20]) * E131_SIZE
    # Sequence numbers with a gap, so there are errors to clear too.
    send([e131(10, data, seq=n) for n in (1, 2, 5)], E131_PORT)
    send([artdmx(ARTNET_UNIVERSE, data[:ARTNET_SIZE], seq=n) for n in (1, 2)], ARTNET_PORT)
    send([ddp(600, data[:30], seq=n) for n in (1, 2)], DDP_PORT)
    fppd.wait_for(lambda: stats(fppd)["10"]["packetsReceived"] == "3"
                  and stats(fppd)[str(ARTNET_UNIVERSE)]["packetsReceived"] == "2"
                  and stats(fppd).get("DDP", {}).get("packetsReceived") == "2",
                  what="the packets counted")
    assert stats(fppd)["10"]["errors"] == "1", stats(fppd)["10"]

    got = api_delete_stats(fppd)
    assert got.get("Status") == "OK" and got.get("Message") == "Stats Cleared", got

    s = stats(fppd)
    for u in ("10", "11", str(ARTNET_UNIVERSE)):
        counts = {k: s[u][k] for k in ("packetsReceived", "bytesReceived", "errors")}
        assert counts == {"packetsReceived": "0", "bytesReceived": "0", "errors": "0"}, \
            f"universe {u} after the reset: {counts}"
    assert "DDP" not in s, f"DDP after the reset: {s['DDP']}"
