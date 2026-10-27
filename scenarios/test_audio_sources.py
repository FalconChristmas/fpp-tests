"""PipeWire audio sources that native plugins publish (AudioSourceRegistry),
as fppd lists them and as the web UI's PHP passes them on: the input mixing
page offers them as input group members. The plugin is audiosrcplugin.cpp,
built by plugin_build.py."""

import json
import os
import subprocess
import tempfile

import plugin_build

# GetPipeWirePluginSources() taken out of the tree's pipewire.php as it is and
# run on its own (the rest of the controller needs Apache), with the API's
# json() helper standing in, and -- where php-curl isn't installed, as in the
# scenario image -- the four curl calls it makes, done with PHP's own HTTP
# stream (the URL and timeout as it sets them).
DRIVER = r"""<?php
function json($v) { return json_encode($v); }
if (!function_exists('curl_init')) {
    function curl_init($url) { return (object) ['url' => $url, 'timeout' => 30]; }
    function curl_setopt($ch, $opt, $val) { if ($opt === 13 /* CURLOPT_TIMEOUT */) { $ch->timeout = $val; } return true; }
    function curl_exec($ch) {
        $ctx = stream_context_create(['http' => ['timeout' => $ch->timeout]]);
        return @file_get_contents($ch->url, false, $ctx);
    }
    function curl_close($ch) {}
    define('CURLOPT_RETURNTRANSFER', 19913);
    define('CURLOPT_CONNECTTIMEOUT', 78);
    define('CURLOPT_TIMEOUT', 13);
}
$src = file_get_contents(getenv('FPP_TREE') . '/www/api/controllers/pipewire.php');
if (!preg_match('/^function GetPipeWirePluginSources\(\).*?^}/ms', $src, $m)) {
    fwrite(STDERR, "GetPipeWirePluginSources() not found\n");
    exit(2);
}
eval($m[0]);
echo GetPipeWirePluginSources();
"""


def php_sources():
    with tempfile.NamedTemporaryFile("w", suffix=".php", delete=False) as f:
        f.write(DRIVER)
    try:
        r = subprocess.run(["php", f.name], capture_output=True, text=True, timeout=30)
    finally:
        os.unlink(f.name)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_a_plugins_audio_source_is_listed_by_fppd_and_the_php_api(fppd):
    """A native plugin that registers an audio source at load -- twice under
    one id, the second time renamed, and another with no PipeWire node name:
    fppd's /pipewire/audio/plugin-sources lists the one source, with its
    second name, node, plugin, channels and rate, and not the nameless one;
    /api/pipewire/audio/plugin-sources (the PHP passthrough the input mixing
    page reads) returns the same list.

    Feature: e633ae9e7 (AudioSourceRegistry). Before it there was nothing
    for a plugin to register with (the plugin doesn't build) and no such
    endpoint. Not covered: the input mixing page's merging of these into
    its member choices (JavaScript)."""
    plugin_build.build_and_install(fppd, "audiosrcplugin.cpp", "fpp-audiosrc")
    fppd.start()
    fppd.wait_for(lambda: "audio source plugin fpp-audiosrc loaded" in fppd.log(), timeout=15,
                  interval=0.25, what="the plugin to load")
    want = [{"id": "fpp-audiosrc:tone", "name": "Test Tone", "nodeName": "fpp_tests_tone",
             "plugin": "fpp-audiosrc", "channels": 2, "sampleRate": 44100}]
    listed = fppd.get("/pipewire/audio/plugin-sources")
    assert listed == {"sources": want}, listed
    assert php_sources() == {"sources": want}
