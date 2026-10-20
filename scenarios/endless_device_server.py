"""A device whose web server never stops answering: every GET gets a 200
and a chunked body that runs on until the client hangs up, at RATE bytes a
second. Serves port 80 on each address given; prints "ready" once
listening, and "closed PATH BYTES" each time a client hangs up. Run inside
fake_devices.device_network()'s namespace.

    endless_device_server.py RATE ADDRESS...
"""

import http.server
import sys
import threading
import time

CHUNK = 64 * 1024


def handler_for(rate):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            body = b"<html><body>" + b"x" * (CHUNK - 12)
            frame = b"%x\r\n" % len(body) + body + b"\r\n"
            start, sent = time.monotonic(), 0
            try:
                while True:
                    self.wfile.write(frame)
                    sent += len(body)
                    ahead = sent / rate - (time.monotonic() - start)
                    if ahead > 0:
                        time.sleep(ahead)
            except OSError:
                pass
            print(f"closed {self.path} {sent}", flush=True)

        def log_message(self, *a):
            pass
    return H


def main():
    rate = float(sys.argv[1])
    for addr in sys.argv[2:]:
        s = http.server.ThreadingHTTPServer((addr, 80), handler_for(rate))
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("ready", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
