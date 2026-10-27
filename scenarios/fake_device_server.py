"""Serves the fake devices described in a JSON file (see fake_devices.py):
one HTTP server per address, port 80, each answering from its own map of
path -> response. Prints "ready" once all are listening. Run inside the
devices' network namespace.

Each server keeps a log of the requests it was sent ("GET /path?query"), which
GET /_requests returns as a JSON list (that request itself is not logged). A
response with "drop" set closes the connection without answering, so the
client sees a failed transfer rather than an HTTP error."""

import http.server
import json
import socket
import socketserver
import sys
import threading


def handler_for(pages):
    log, lock = [], threading.Lock()

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def answer(self):
            path = self.path.split("?", 1)[0]
            if self.command == "GET" and path == "/_requests":
                with lock:
                    p = {"status": 200, "type": "application/json", "body": json.dumps(log)}
            else:
                with lock:
                    log.append(f"{self.command} {self.path}")
                p = pages.get(self.path) or pages.get(path) or {
                    "status": 404, "type": "text/html", "body": "Not found", "headers": {}}
            if p.get("drop"):
                self.close_connection = True
                return
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
        cls, where = http.server.ThreadingHTTPServer, (addr, 80)
        if ":" in addr:
            cls = type("Server6", (cls,), {"address_family": socket.AF_INET6,
                                           # no getfqdn() of the address: a reverse lookup
                                           # of a link-local one can hang
                                           "server_bind": socketserver.TCPServer.server_bind})
            # "fe80::2%dev": a link-local address binds with its interface's index
            where = socket.getaddrinfo(addr, 80, socket.AF_INET6, socket.SOCK_STREAM)[0][4]
        s = cls(where, handler_for(pages))
        s.daemon_threads = True
        servers.append(s)
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("ready", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
