"""A fake Twinkly, run inside the device namespace (see fake_devices.py).

    python3 fake_twinkly.py ADDRESS LOGFILE [REJECT_VERIFIES]

Answers the xled calls FPP's Twinkly output makes (login, verify, led/mode)
the way the lights do, failures in the body ({"code":1102}) rather than the
status line, and takes realtime frames on UDP 7777 (v3 packets: 0x03, the
8-byte token, two zero bytes, the fragment index, then up to 900 channels).
Every call and every frame is appended to LOGFILE as a JSON line. The first
REJECT_VERIFIES verify calls are refused, as a light refuses a stale token;
writing a count to LOGFILE.reject refuses that many more, from the next one.
While LOGFILE.refuse-logins exists, logins fail with HTTP 500.
"""

import base64
import http.server
import json
import os
import socket
import sys
import threading

ADDR, LOG = sys.argv[1], sys.argv[2]
state = {"rejects": int(sys.argv[3]) if len(sys.argv) > 3 else 0, "token": None}
lock = threading.Lock()


def log(**ev):
    with lock, open(LOG, "a") as f:
        f.write(json.dumps(ev) + "\n")


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def reply(self, obj, status=200):
        body = json.dumps(obj).encode() if not isinstance(obj, str) else obj.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        log(ev="http", method="GET", path=self.path)
        self.reply("This URI does not exist", 404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode(errors="replace")
        token = self.headers.get("X-Auth-Token")
        log(ev="http", method="POST", path=self.path, token=token, body=body)
        ok = token is not None and token == state["token"]
        if self.path == "/xled/v1/login" and os.path.exists(LOG + ".refuse-logins"):
            self.reply({"code": 1105}, 500)
        elif self.path == "/xled/v1/login":
            state["token"] = base64.b64encode(os.urandom(8)).decode()
            self.reply({"authentication_token": state["token"], "authentication_token_expires_in": 14400,
                        "challenge-response": "00", "code": 1000})
        elif self.path == "/xled/v1/verify":
            try:
                with open(LOG + ".reject") as f:
                    state["rejects"] += int(f.read())
                os.unlink(LOG + ".reject")
            except FileNotFoundError:
                pass
            if state["rejects"] > 0:
                state["rejects"] -= 1
                ok = False
            log(ev="verify", token=token, ok=ok)
            self.reply({"code": 1000 if ok else 1102})
        elif self.path == "/xled/v1/led/mode":
            self.reply({"code": 1000 if ok else 1102})
        else:
            self.reply("This URI does not exist", 404)

    def log_message(self, *a):
        pass


def udp():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((ADDR, 7777))
    while True:
        data, _ = s.recvfrom(2048)
        log(ev="udp", version=data[0], token=base64.b64encode(data[1:9]).decode(),
            fragment=data[11], data=data[12:].hex())


def main():
    srv = http.server.ThreadingHTTPServer((ADDR, 80), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=udp, daemon=True).start()
    print("ready", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
