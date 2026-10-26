"""Fake devices that stop answering on cue: serves the devices described in a
JSON file (as fake_device_server.py does: {address: {path: page}}, port 80)
until the file FLAG exists, after which every request is held open,
unanswered, for a minute. Prints "ready" once all are listening, and "held
<address> <path>" for each request it holds. Run inside the devices' network
namespace (fake_devices.device_network()).

    held_device_server.py DEVICES.json FLAG
"""

import http.server
import json
import os
import sys
import threading
import time


def handler_for(address, pages, flag, out_lock):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if os.path.exists(flag):
                with out_lock:
                    print(f"held {address} {path}", flush=True)
                time.sleep(60)
                self.close_connection = True
                return
            p = pages.get(self.path) or pages.get(path) or {
                "status": 404, "type": "text/html", "body": "Not found"}
            body = p["body"].encode()
            self.send_response(p["status"])
            self.send_header("Content-Type", p["type"])
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass
    return H


def main():
    devices = json.load(open(sys.argv[1]))
    flag = sys.argv[2]
    out_lock = threading.Lock()
    for address, pages in devices.items():
        s = http.server.ThreadingHTTPServer((address, 80), handler_for(address, pages, flag, out_lock))
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("ready", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
