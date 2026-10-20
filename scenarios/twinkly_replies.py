"""Answers fppd's Twinkly discovery broadcast as if from many lights, and
reports fppd's HTTP probes of them. Run inside fake_devices.py's network
namespace, with the reply addresses already on its interface:

    twinkly_replies.py FIRST_BATCH SECOND_BATCH DELAY

where each batch is a comma-separated list of addresses. Waits for the
discovery datagram on UDP 5555 and prints "port N"; answers it from every
address in FIRST_BATCH at once; then, DELAY seconds later, from every
address in SECOND_BATCH, and prints "sent". Every HTTP request to port 80
is answered with a 404 and printed as "probe ADDRESS" (the address it was
made to)."""

import http.server
import socket
import socketserver
import sys
import threading
import time


class Probe(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        print("probe", self.connection.getsockname()[0], flush=True)
        body = b"Not found"
        self.send_response(404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def answer(addresses, dest):
    for a in addresses:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind((a, 0))
        # the light's own address (least significant byte first), "OK", a name
        s.sendto(bytes(reversed(socket.inet_aton(a))) + b"OKfake", dest)
        s.close()


def main():
    first, second = (b.split(",") if b else [] for b in sys.argv[1:3])
    delay = float(sys.argv[3])
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
    answer(first, src)
    time.sleep(delay)
    answer(second, src)
    print("sent", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
