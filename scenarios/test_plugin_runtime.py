"""Compiled (C++) plugins loaded into a running fppd -- the Plugin Manager's
load after an install -- and the helpers out-of-tree plugins call.

Each plugin is a small source in tools/, built against the tree under test
(throw_plugin.py).
"""

import gzip
import http.server
import json
import threading
import time
import urllib.error
import urllib.parse

import throw_plugin
from fake_devices import fake_devices, page
from show import ddp_output


def load(fppd, source, name):
    throw_plugin.install(fppd, source=source, name=name)
    fppd.post(f"/fppd/plugin/{name}/load", {}, timeout=40)


def status_of(fppd, path):
    try:
        fppd.get(path)
        return 200
    except urllib.error.HTTPError as e:
        return e.code


def post_status(fppd, path):
    try:
        fppd.post(path, {})
        return 200
    except urllib.error.HTTPError as e:
        return e.code


def test_routes_of_a_plugin_loaded_at_runtime(fppd):
    """A plugin loaded after fppd started serves its routes: an exact path,
    and every subpath of a family registration. A method it did not
    register answers 405, and once it is unloaded its paths answer 410.

    Regression: 6f0a8be76. Plugin paths were drogon routes, registered when
    the plugin loaded. Drogon's router is frozen once it runs: a late
    registration asserted where asserts are on, and otherwise edited the
    router unlocked and never compiled the family's regex route, so a
    plugin installed without a restart had subpaths that answered 404.

    Also covers 07f19dda1, the runtime load and unload, and the route half
    of 1a5f596e1: registerPluginApi() routes a plugin gives back, which
    answer 410 once it is gone. And, under TSan, 547a957ac: drogon's quit()
    freed its router while an IO thread was still in it from the last
    plugin route served."""
    fppd.start()
    load(fppd, "lateroutesplugin.cpp", "fpp-late")
    assert fppd.get("/late/ok") == "ok"
    assert fppd.get("/late/fam") == "fam /late/fam"
    assert fppd.get("/late/fam/a/b") == "fam /late/fam/a/b", "a family subpath of a runtime-loaded plugin"
    assert post_status(fppd, "/late/ok") == 405
    fppd.post("/fppd/plugin/fpp-late/unload", {}, timeout=40)
    assert status_of(fppd, "/late/ok") == 410
    assert status_of(fppd, "/late/fam/a/b") == 410
    fppd.check_alive()


def test_unloading_a_channel_data_plugin_mid_frame(fppd):
    """Unloading a channel-data plugin while the output thread is inside its
    modifyChannelData() waits for that frame; the plugin is not destroyed
    under it.

    Regression: 5fd948049. The output thread walked the channel-data plugin
    list unlocked while an unload on the main loop dropped the plugin from
    it and deleted it at once: the frame still running in the plugin then
    used the freed object (an ASan heap-use-after-free)."""
    fppd.write("config/co-universes.json", ddp_output())
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    load(fppd, "channeldataplugin.cpp", "fpp-chdata")
    fppd.command("Test Start", 50, "RGB Chase", "1-150", "R-G-B")
    assert fppd.get("/chdata/arm") == "armed"
    fppd.wait_for(lambda: fppd.get("/chdata/inside") == "yes", timeout=10, interval=0.02,
                  what="a frame inside the plugin's modifyChannelData()")
    fppd.post("/fppd/plugin/fpp-chdata/unload", {}, timeout=40)
    # The frame that was inside it finishes (300 ms), and the next ones run
    # without it.
    time.sleep(1.5)
    fppd.command("Test Stop")
    fppd.check_alive()


WLED = {
    "/": page("<html><title>WLED UI</title></html>"),
    "/json/info": page({"ver": "0.14.1", "name": "fake-wled", "arch": "esp32",
                        "mac": "aabbcc000005"}),
}


def test_the_blocking_controller_detection_overload(fppd):
    """A plugin built against the two-argument, blocking
    NetworkController::DetectControllerViaHTML(ip, html) still builds, and the
    call returns the detected controller, after asking the device what the
    page alone doesn't say.

    Regression: 7ff219763. Making detection asynchronous replaced it with a
    callback form, so such a plugin no longer built (here: throw_plugin.py's
    build fails)."""
    with fake_devices({"10.88.0.5": WLED}):
        fppd.start()
        load(fppd, "detectcompatplugin.cpp", "fpp-detect")
        q = urllib.parse.urlencode({"ip": "10.88.0.5", "html": WLED["/"]["body"]})
        assert fppd.get(f"/detect?{q}", timeout=30) == "WLED|fake-wled|0.14.1"
        q = urllib.parse.urlencode({"ip": "10.88.0.5", "html": "<html>Some other web page</html>"})
        assert fppd.get(f"/detect?{q}", timeout=30) == "none"


class _GzipAlways(http.server.BaseHTTPRequestHandler):
    """Answers gzip whatever the request's Accept-Encoding, as some
    controllers do."""
    BODY = gzip.compress(json.dumps({"name": "fake-controller", "ver": "1.2"}).encode())

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(self.BODY)))
        self.end_headers()
        self.wfile.write(self.BODY)

    def log_message(self, *args):
        pass


def test_url_get_decodes_a_gzip_reply(fppd):
    """urlGet(), which plugins call against devices, hands back the decoded
    body of a reply the device gzipped without being asked to.

    Regression: 7b4a14360. urlHelper() never set CURLOPT_ACCEPT_ENCODING, so
    the caller got the compressed bytes and every parse of them failed."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _GzipAlways)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        fppd.start()
        load(fppd, "urlgetplugin.cpp", "fpp-urlget")
        url = f"http://127.0.0.1:{server.server_address[1]}/json/info"
        got = fppd.get("/urlget?" + urllib.parse.urlencode({"url": url}), timeout=20)
        assert got == {"name": "fake-controller", "ver": "1.2"}, f"urlGet handed back {got!r:.200}"
    finally:
        server.shutdown()


def test_unloading_a_plugin_with_a_request_inside_its_route(fppd):
    """A plugin unloaded while a request is inside its route handler: the
    unload waits for the handler, the request gets its answer, and fppd
    carries on.

    Regression: 824f1d6a6. Clearing the route made newly arriving requests
    safe, but one already past the lookup was left running in the plugin
    while the unload went on to dlclose() it, unmapping the code under the
    handler. The router has been rewritten since (6f0a8be76); the drain is
    in its disarm."""
    import os
    mark = os.path.join(fppd.media, "tmp", "slowroute.entered")
    fppd.start(extra_env={"SLOWROUTE_MARK": mark})
    load(fppd, "slowrouteplugin.cpp", "fpp-slowroute")
    got = {}

    def request():
        try:
            got["answer"] = fppd.get("/slow/wait", timeout=30)
        except Exception as e:  # recorded, asserted on below
            got["error"] = repr(e)
    t = threading.Thread(target=request)
    t.start()
    fppd.wait_for(lambda: os.path.exists(mark), timeout=10, interval=0.1, what="the request to reach the handler")
    fppd.post("/fppd/plugin/fpp-slowroute/unload", {}, timeout=40)
    t.join(35)
    assert got == {"answer": "done"}, got
    assert status_of(fppd, "/slow/wait") == 410
    fppd.check_alive()
