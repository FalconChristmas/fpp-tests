"""See UDP packets fppd sends to an address on this machine without binding
its port (fppd holds 32320 on every address itself): a raw packet socket on
the loopback interface. Needs root, which the container and run-local.sh
both have."""

import socket
import struct
import threading
import time

ETH_P_ALL = 0x0003
PACKET_OUTGOING = 4


class UdpCapture:
    def __init__(self, dst_port, dst_ip=None, iface="lo"):
        self.dst_port = dst_port
        self.dst_ip = dst_ip
        self.iface = iface
        self.packets = []  # (monotonic time, src ip, dst ip, payload)
        self.lock = threading.Lock()
        self.sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_ALL))
        self.sock.bind((iface, 0))
        self.sock.settimeout(0.2)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                frame, addr = self.sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            # loopback shows each packet twice, leaving and arriving: keep one.
            # Elsewhere (a dummy interface) leaving is the only copy there is.
            if addr[2] == PACKET_OUTGOING and self.iface == "lo":
                continue
            ip = frame[14:]
            if len(ip) < 28 or ip[0] >> 4 != 4 or ip[9] != 17:
                continue
            ihl = (ip[0] & 0x0F) * 4
            src, dst = socket.inet_ntoa(ip[12:16]), socket.inet_ntoa(ip[16:20])
            sport, dport, ulen = struct.unpack(">HHH", ip[ihl:ihl + 6])
            if dport != self.dst_port or (self.dst_ip and dst != self.dst_ip):
                continue
            payload = ip[ihl + 8:ihl + ulen]
            with self.lock:
                self.packets.append((time.monotonic(), src, dst, payload))

    def snapshot(self):
        with self.lock:
            return list(self.packets)

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
