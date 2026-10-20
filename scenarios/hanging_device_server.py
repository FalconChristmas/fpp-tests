"""Fake FPP players that never finish answering: each address given on the
command line serves an FPP front page on port 80, and holds every other
request (the detector's /api/system/info) open without a reply until it is
killed. Prints "ready" once all are listening. Run inside the fake device
network namespace (fake_devices.device_network()).

    hanging_device_server.py 10.88.0.10,10.88.0.11,...
"""

import http.server
import sys
import threading
import time

FRONT = b"<html><title>Falcon Player - FPP</title></html>"


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(FRONT)))
            self.end_headers()
            self.wfile.write(FRONT)
            return
        time.sleep(3600)

    def log_message(self, *a):
        pass


def main():
    for addr in sys.argv[1].split(","):
        s = http.server.ThreadingHTTPServer((addr, 80), H)
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("ready", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
