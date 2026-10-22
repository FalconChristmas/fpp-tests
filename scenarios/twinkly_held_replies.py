"""Answers fppd's Twinkly discovery broadcast as if from many lights at once,
and holds each HTTP probe of them open for a while, to see how many fppd
makes at a time. Run inside fake_devices.py's network namespace, with the
reply addresses already on its interface:

    twinkly_held_replies.py ADDRESSES HOLD

where ADDRESSES is a comma-separated list. Waits for the discovery datagram
on UDP 5555 and prints "port N"; answers it from every address at once;
answers every HTTP request to port 80 with a 404 after HOLD seconds, printing
"probe ADDRESS" as it arrives and "open N" each time the number of probes
open at once reaches a new high."""

import http.server
import socket
import socketserver
import sys
import threading
import time

lock = threading.Lock()
state = {"open": 0, "max": 0}
HOLD = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0


class Probe(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        print("probe", self.connection.getsockname()[0], flush=True)
        with lock:
            state["open"] += 1
            if state["open"] > state["max"]:
                state["max"] = state["open"]
                print("open", state["max"], flush=True)
        try:
            time.sleep(HOLD)
            body = b"Not found"
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        finally:
            with lock:
                state["open"] -= 1

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 256


def main():
    addresses = sys.argv[1].split(",")
    srv = Server(("0.0.0.0", 80), Probe)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    u.bind(("0.0.0.0", 5555))
    print("ready", flush=True)
    while True:
        data, src = u.recvfrom(1500)
        if data.startswith(b"\x01discover"):
            break
    print("port", src[1], flush=True)
    for a in addresses:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind((a, 0))
        # the light's own address (least significant byte first), "OK", a name
        s.sendto(bytes(reversed(socket.inet_aton(a))) + b"OKfake", src)
        s.close()
    print("sent", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
