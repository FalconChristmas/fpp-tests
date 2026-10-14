"""Serves the fake devices described in a JSON file (see fake_devices.py):
one HTTP server per address, port 80, each answering from its own map of
path -> response. Prints "ready" once all are listening. Run inside the
devices' network namespace."""

import http.server
import json
import sys
import threading


def handler_for(pages):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def answer(self):
            path = self.path.split("?", 1)[0]
            p = pages.get(self.path) or pages.get(path) or {
                "status": 404, "type": "text/html", "body": "Not found", "headers": {}}
            body = p["body"].encode()
            self.send_response(p["status"])
            self.send_header("Content-Type", p["type"])
            self.send_header("Content-Length", str(len(body)))
            for k, v in p.get("headers", {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.answer()

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(n)
            self.answer()

        def log_message(self, *a):
            pass
    return H


def main():
    devices = json.load(open(sys.argv[1]))
    servers = []
    for addr, pages in devices.items():
        s = http.server.ThreadingHTTPServer((addr, 80), handler_for(pages))
        s.daemon_threads = True
        servers.append(s)
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("ready", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
