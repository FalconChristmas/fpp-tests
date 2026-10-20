"""AES67 audio over IP: SAP stream discovery from the LAN, and PTP.

AES67Manager runs only under MediaBackend "pipewire" and with an instances
file. A receive instance with SAP on starts the SAP receiver even with no
PipeWire running (its pipeline fails, the receiver doesn't care), so these
need no audio fixture. Announcements come from 127.0.0.x addresses other
than 127.0.0.1, which is fppd's own on lo and ignored as such.
"""

import os
import socket
import struct
import time

import pytest

SAP_PORT = 9875
CLOCK_ID = "00-11-22-FF-FE-33-44-55"


def receive_only(fppd):
    fppd.settings(MediaBackend="pipewire")
    fppd.write("config/pipewire-aes67-instances.json", {
        "ptpEnabled": False, "ptpInterface": "lo",
        "instances": [{"id": 1, "name": "rx", "mode": "receive", "enabled": True, "sapEnabled": True,
                       "multicastIP": "127.0.0.1", "port": 5004}]})


def sap_packet(msg_hash, origin, name, clock_line=True):
    """A SAP announcement (RFC 2974) of an AES67 stream's SDP."""
    sdp = (f"v=0\r\no=- {msg_hash} 1 IN IP4 {origin}\r\ns={name}\r\nc=IN IP4 239.69.0.1/32\r\n"
           "t=0 0\r\nm=audio 5004 RTP/AVP 96\r\na=rtpmap:96 L24/48000/2\r\na=ptime:1\r\n")
    if clock_line:
        sdp += f"a=ts-refclk:ptp=IEEE1588-2008:{CLOCK_ID}:0\r\n"
    return (struct.pack(">BBH", 0x20, 0, msg_hash) + socket.inet_aton(origin) +
            b"application/sdp\0" + sdp.encode())


def announce(origin, packets, pause=0.001):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind((origin, 0))
        for p in packets:
            s.sendto(p, ("127.0.0.1", SAP_PORT))
            time.sleep(pause)
    finally:
        s.close()


def discovered(fppd):
    return fppd.get("/aes67/status").get("discoveredStreams") or []


def test_sap_stream_reports_its_ptp_clock(fppd):
    """A discovered stream's SDP names its PTP grandmaster in an
    a=ts-refclk line; /aes67/status reports that clock id.

    Regression: 2bd6eaa12. The line was matched by comparing its first 26
    characters with a 25-character literal, which never succeeded, so
    ptpClockId was always empty."""
    receive_only(fppd)
    fppd.start()
    fppd.wait_for(lambda: "SAP receiver thread started" in fppd.log(), timeout=60,
                  what="the SAP receiver")
    announce("127.0.0.2", [sap_packet(7, "127.0.0.2", "Desk")])
    streams = fppd.wait_for(lambda: [s for s in discovered(fppd) if s.get("sessionName") == "Desk"],
                            timeout=10, what="the announced stream to be listed")
    assert streams[0].get("ptpClockId") == CLOCK_ID, streams[0]


def test_sap_discovery_is_bounded_and_keyed_by_origin(fppd):
    """300 announcements with distinct hashes and 1000-character names keep
    at most 256 streams with names of at most 256 characters, and two
    senders that happen to use the same hash are both listed.

    Regression: ecee17a05. Anything on the LAN could grow the discovered
    list without limit, each entry keeping its fields at whatever length the
    datagram carried; and streams were keyed by the 16-bit hash alone, so
    the second sender of a hash replaced the first."""
    receive_only(fppd)
    fppd.start()
    fppd.wait_for(lambda: "SAP receiver thread started" in fppd.log(), timeout=60,
                  what="the SAP receiver")
    announce("127.0.0.3", [sap_packet(7, "127.0.0.3", "Same hash A")])
    announce("127.0.0.4", [sap_packet(7, "127.0.0.4", "Same hash B")])
    fppd.wait_for(lambda: len(discovered(fppd)) >= 1, timeout=10, what="a discovered stream")
    announce("127.0.0.2", [sap_packet(1000 + i, "127.0.0.2", f"S{i:03d}" + "x" * 996)
                           for i in range(300)])
    time.sleep(2)
    # The two same-hash senders again, now the freshest entries.
    announce("127.0.0.3", [sap_packet(7, "127.0.0.3", "Same hash A")])
    announce("127.0.0.4", [sap_packet(7, "127.0.0.4", "Same hash B")])
    time.sleep(1)
    streams = discovered(fppd)
    assert len(streams) <= 256, f"{len(streams)} discovered streams kept"
    longest = max(len(s.get("sessionName", "")) for s in streams)
    assert longest <= 256, f"a session name kept at {longest} characters"
    names = {s.get("sessionName") for s in streams}
    assert {"Same hash A", "Same hash B"} <= names, \
        f"senders sharing a hash: {sorted(n for n in names if n.startswith('Same'))}"


def receive_without_sap(fppd, ptp=False):
    fppd.settings(MediaBackend="pipewire")
    fppd.write("config/pipewire-aes67-instances.json", {
        "ptpEnabled": ptp, "ptpInterface": "lo", "ptpLockWaitMs": 0,
        "instances": [{"id": 1, "name": "rx", "mode": "receive", "enabled": True, "sapEnabled": False,
                       "multicastIP": "127.0.0.1", "port": 5004, "channels": 2}]})


def test_ptp_that_failed_to_start_is_started_later(fppd):
    """PTP enabled, and ptp4l failing to start at first (a stand-in exits
    at once until a flag file exists): once it can run, the watchdog starts
    it and the "could not start" warning comes down.

    Regression: de536a0f6. The watchdog returned at once while PTP was not
    initialised, so a failed start was never tried again until the config
    was applied by hand.

    fppd checks /usr/sbin/ptp4l exists and then runs ptp4l from PATH; the
    test container has no linuxptp, so an empty /usr/sbin/ptp4l is made
    there (and only there) for the run."""
    flag = os.path.join(fppd.media, "tmp", "ptp4l.ok")
    made = False
    if not os.path.exists("/usr/sbin/ptp4l"):
        if not os.path.exists("/etc/fpp/container"):
            pytest.skip("needs /usr/sbin/ptp4l (only made inside the test container)")
        with open("/usr/sbin/ptp4l", "w") as f:
            f.write("#!/bin/sh\nexit 1\n")
        os.chmod("/usr/sbin/ptp4l", 0o755)
        made = True
    try:
        bindir = os.path.join(fppd.media, "tmp", "bin")
        os.makedirs(bindir)
        with open(os.path.join(bindir, "ptp4l"), "w") as f:
            f.write(f'#!/bin/sh\n[ -e "{flag}" ] || exit 1\nexec sleep 1000\n')
        os.chmod(os.path.join(bindir, "ptp4l"), 0o755)
        receive_without_sap(fppd, ptp=True)
        fppd.start(extra_env={"PATH": bindir + ":" + os.environ["PATH"]})

        def warned():
            return any("ptp4l) could not start" in w for w in fppd.get("/fppd/status").get("warnings", []))
        fppd.wait_for(warned, timeout=30, interval=0.5, what="the PTP could-not-start warning")
        open(flag, "w").close()
        fppd.wait_for(lambda: not warned(), timeout=70, interval=0.5,
                      what="PTP to be started and its warning to come down")

        def running():
            for pid in os.listdir("/proc"):
                try:
                    with open(f"/proc/{pid}/cmdline", "rb") as f:
                        if f.read() == b"sleep\x001000\x00":
                            return True
                except OSError:
                    pass
            return False
        assert running(), "the warning came down, but no ptp4l (stand-in) is running"
    finally:
        if made:
            os.unlink("/usr/sbin/ptp4l")
