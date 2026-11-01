"""An AES67 stream that fails while running is brought back by the
watchdog: its pipeline posts a GStreamer ERROR, and fppd rebuilds it.

The `audio` fixture's private PipeWire is the graph. A receive instance's
pipeline ends in a PipeWire source node (aes67_<name>_recv); the scenario sends it
L24 RTP from 127.0.0.1 and listens to that node with pw-record. Destroying
the node from outside, as a PipeWire restart or a session manager would,
makes pipewiresink post an ERROR and stop.
"""

import json
import math
import socket
import struct
import subprocess
import threading
import time

import pytest

from fppd import sanitizer

CONFIG = "config/pipewire-aes67-instances.json"
NODE = "aes67_rx_recv"
PORT = 5004

pytestmark = pytest.mark.skipif(sanitizer() == "tsan", reason="a live stream under TSan can't keep time")


class RtpTone:
    """A stereo L24 48 kHz RTP stream of a 1 kHz tone to 127.0.0.1:PORT, a
    packet every millisecond, until stop()."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        seq, ts = 0, 0
        frames = []
        for i in range(48):
            v = int(0.5 * 8388607 * math.sin(2 * math.pi * 1000 * i / 48000)) & 0xFFFFFF
            frames.append(v.to_bytes(3, "big") * 2)
        payload = b"".join(frames)
        nxt = time.monotonic()
        while not self.done.is_set():
            hdr = struct.pack("!BBHII", 0x80, 96, seq & 0xFFFF, ts & 0xFFFFFFFF, 0x12345678)
            self.sock.sendto(hdr + payload, ("127.0.0.1", PORT))
            seq += 1
            ts += 48
            nxt += 0.001
            d = nxt - time.monotonic()
            if d > 0:
                time.sleep(d)

    def stop(self):
        self.done.set()
        self.thread.join(5)
        self.sock.close()


def node_ids(audio, name):
    dump = json.loads(subprocess.run(["pw-dump"], env=audio.env, capture_output=True, text=True).stdout)
    return [o["id"] for o in dump if o.get("type") == "PipeWire:Interface:Node"
            and o["info"]["props"].get("node.name") == name]


def loudness(audio, node, seconds=1.5):
    """Peak level heard from `node` over `seconds` (pw-record of it)."""
    import tempfile
    import wave
    path = tempfile.mktemp(suffix=".wav")
    p = subprocess.Popen(["pw-record", "--target", node, "--rate", "48000", "--channels", "1",
                          "--format", "s16", path], env=audio.env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(seconds)
    p.terminate()
    p.wait(5)
    try:
        with wave.open(path) as w:
            data = w.readframes(w.getnframes())
    except (FileNotFoundError, EOFError, wave.Error):
        return 0.0
    samples = struct.unpack(f"<{len(data) // 2}h", data)
    return max((abs(s) for s in samples), default=0) / 32768


def test_a_receiver_whose_pipeline_errors_is_rebuilt(fppd, audio):
    """A receive stream playing a tone, whose PipeWire node is destroyed
    from outside: its pipeline posts an ERROR and stops. The watchdog
    rebuilds it (the first error at once, on its next pass), and the tone
    is heard from the new node within a minute.

    Regression: d5e71160c. The watchdog only logged a pipeline's ERROR and
    noted it; a receiver has no stall check, so it stayed silent -- while
    the status still called it running -- until the config was applied by
    hand. Not covered: the backoff for an error that keeps coming back."""
    fppd.settings(MediaBackend="pipewire")
    fppd.write(CONFIG, {"ptpEnabled": False, "ptpInterface": "lo", "requireGroupSource": False,
                        "instances": [{"id": 1, "name": "rx", "mode": "receive", "enabled": True,
                                       "sapEnabled": False, "multicastIP": "127.0.0.1", "port": PORT,
                                       "channels": 2}]})
    tone = RtpTone()
    try:
        fppd.start()
        fppd.wait_for(lambda: node_ids(audio, NODE), timeout=30, what="the receiver's node")
        assert loudness(audio, NODE) > 0.2, "precondition: the tone wasn't heard from the receiver"
        first = node_ids(audio, NODE)
        subprocess.run(["pw-cli", "destroy", str(first[0])], env=audio.env, capture_output=True, timeout=10)
        fppd.wait_for(lambda: "AES67 recv pipeline error [1]" in fppd.log() or "bus error" in fppd.log(),
                      timeout=40, what="the receiver's pipeline to post an error (precondition)")
        fppd.wait_for(lambda: [i for i in node_ids(audio, NODE) if i not in first], timeout=70, interval=1,
                      what="a rebuilt receiver")
        fppd.wait_for(lambda: loudness(audio, NODE) > 0.2, timeout=20, interval=0.5,
                      what="the tone from the rebuilt receiver")
    finally:
        tone.stop()


def test_cleanup_cancels_a_pending_rebuild(fppd, audio):
    """A SAP-announcing sender whose every RTP send fails (rtpdrop.c), so the
    watchdog finds it stalled and schedules a rebuild. "AES67 Cleanup" sent
    the moment the rebuild is scheduled stops everything, and it stays
    stopped: the rebuild doesn't run.

    Regression: 01247b497. Cleanup() never cancelled a pending rebuild, and
    the rebuild thread, past its half-second wait, ran ApplyConfig() and
    started the pipelines Cleanup had just stopped. Not covered: the races
    with Shutdown(), and Opus RTP's half of the commit.

    Also b2969924a (the pipeline watchdog): the sender's stall is found by
    the watchdog's byte-count check (udpsink's bytes-served unchanged over
    two passes) and scheduled for a rebuild; with that check off the
    scenario waits out its 120 s for "rebuild needed". Not covered: the
    watchdog's set-to-PLAYING recovery of a pipeline that left that state."""
    import shims
    from test_aes67_wire import start_sender
    start_sender(fppd, audio, preload=[shims.build("rtpdrop.c")], env={"RTPDROP_EVERY": "1"},
                 instances=[{"id": 1, "name": "tx", "mode": "send", "enabled": True, "sapEnabled": True,
                             "multicastIP": "127.0.0.1", "port": PORT, "channels": 2}])
    fppd.wait_for(lambda: "AES67 watchdog: rebuild needed" in fppd.log(), timeout=120, interval=0.01,
                  what="the watchdog to schedule a rebuild of the stalled sender")
    fppd.command("AES67 Cleanup", timeout=60)
    time.sleep(8)
    log = fppd.log()
    after = log[log.rindex("AES67Manager: Cleanup"):]
    # Any ApplyConfig() after the Cleanup loads the config again (with no
    # feed, the sender it builds then fails to start).
    assert "Loaded config" not in after, "the rebuild ran after Cleanup:\n" + "\n".join(
        l for l in after.splitlines() if "AES67" in l and "bus warning" not in l)
