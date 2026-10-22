"""An AES67 sender's RTP stream, captured off the wire.

The `audio` fixture's private PipeWire stands in for the audio graph. On a
player an Audio Output Group feeds the sender's node; here the scenario links
the null sink's monitor into it once the node appears, so the sender runs on
the graph's clock with a continuous source, as it does on a player between
tracks. The stream goes to 127.0.0.1, where rtp_capture.py records each
packet with its kernel arrival time.

PTP is on with no ptp4l installed, so the media clock is CLOCK_REALTIME: the
same clock the capture timestamps arrivals with, which is what lets a test
measure the transmit lead (how far ahead of its own RTP time each packet
arrives) directly.
"""

import glob
import re
import statistics
import subprocess
import threading
import time

import pytest

from fppd import sanitizer
from rtp_capture import RtpCapture, discontinuities

# Under TSan these neither keep time nor say anything about races: the
# sender's state reaches its streaming threads, and is freed after them,
# through GStreamer's and PipeWire's own locks, which the suppressions make
# TSan ignore, so a live stream reports every probe-state hand-off; and the
# slowdown alone puts packets after their own time.
pytestmark = pytest.mark.skipif(sanitizer() == "tsan", reason="timing scenarios; see above")

CONFIG = "config/pipewire-aes67-instances.json"
NODE = "aes67_tx_send"
TARGET_LEAD_MS = 3


def ports(audio, node):
    out = subprocess.run(["pw-link", "-i"], env=audio.env, capture_output=True, text=True).stdout
    return [l.strip() for l in out.splitlines() if l.strip().startswith(node + ":")]


def link(audio, node, connect=True):
    """Link (or unlink) the null sink's monitor into the sender's first two
    inputs."""
    targets = ports(audio, node)
    for src, dst in zip(["fpp_test_sink:monitor_FL", "fpp_test_sink:monitor_FR"], targets):
        subprocess.run(["pw-link"] + ([] if connect else ["-d"]) + [src, dst],
                       env=audio.env, capture_output=True, text=True)
    return targets


def start_sender(fppd, audio, channels=2, link_delay=0, **top):
    """Start fppd with one send instance and feed it once its node appears
    (link_delay seconds after). The sender's pipeline only reaches PLAYING
    once something feeds it."""
    # requireGroupSource off: no Audio Output Group feeds this sender (the
    # scenario links it by hand), and on a player the generated groups conf
    # would hold it idle.
    cfg = {"ptpEnabled": True, "ptpInterface": "lo", "ptpLockWaitMs": 0, "requireGroupSource": False,
           "instances": [{"id": 1, "name": "tx", "mode": "send", "enabled": True,
                          "sapEnabled": False, "multicastIP": "127.0.0.1", "port": 5004,
                          "channels": channels}]}
    cfg.update(top)
    fppd.write(CONFIG, cfg)
    fppd.settings(MediaBackend="pipewire")
    linked = []

    def linker():
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if ports(audio, NODE):
                time.sleep(link_delay)
                link(audio, NODE)
                linked.append(True)
                return
            time.sleep(0.02)
    t = threading.Thread(target=linker, daemon=True)
    t.start()
    fppd.start()
    t.join(45)
    assert linked, "the sender's PipeWire node never appeared"
    fppd.wait_for(lambda: "AES67 send pipeline [1] tx started" in fppd.log(), timeout=40,
                  what="the send pipeline to start")


def window(cap, seconds):
    """The packets that arrive over the next `seconds`."""
    t = time.time_ns()
    time.sleep(seconds)
    return [p for p in cap.since(t) if p.arrival_ns < t + int(seconds * 1e9)]


def leads(packets):
    return sorted(p.lead_ms() for p in packets)


def pct(sorted_values, q):
    return sorted_values[min(len(sorted_values) - 1, int(q * len(sorted_values)))]


@pytest.mark.parametrize("channels", [2, 8])
def test_stream_is_one_packet_per_ms_ahead_of_its_time(fppd, audio, channels):
    """Steady state: one L24 packet per millisecond (payload channels x 3 x
    48 bytes), sequence numbers and timestamps advancing by exactly 1 and 48,
    and each packet arriving before its own RTP time, by about the 3 ms the
    lead servo holds.

    Regressions: 53a4d7480 (above stereo not one packet went out),
    36d36f165 (timestamp steps wobbled by a sample around 48),
    cc1c90988 (paced packets left about 23.7 ms after their playout time),
    51f8b2046 / cdb9515d4 (the lead is measured and held, not set open-loop).
    Feature: 312d823c6 (1 ms by default); 7cd75d11f (the GStreamer AES67 sender)."""
    with RtpCapture(5004) as cap:
        start_sender(fppd, audio, channels=channels)
        time.sleep(3)  # the servo steps the lead in on the first packets
        pk = window(cap, 8)
    assert len(pk) > 7000, f"{len(pk)} packets in 8 s"
    sizes = {p.payload_len for p in pk}
    assert sizes == {channels * 3 * 48}, sizes
    assert {p.pt for p in pk} == {96}
    gaps = discontinuities(pk, 48)
    assert not gaps, f"seq/timestamp breaks (index, dseq, dts): {gaps[:10]}"
    span = (pk[-1].arrival_ns - pk[0].arrival_ns) / 1e9
    rate = (len(pk) - 1) / span
    assert 980 < rate < 1020, f"{rate:.1f} packets/s"
    lead = leads(pk)
    median = statistics.median(lead)
    assert abs(median - TARGET_LEAD_MS) < 1.5, f"median lead {median:.2f} ms"
    assert pct(lead, 0.05) > 0, f"5% of packets arrived after their own time (p5 {pct(lead, 0.05):.2f} ms)"


def test_a_source_linked_late_still_paces_ahead_of_its_time(fppd, audio):
    """The sender's node is fed a second after its pipeline is built (a group
    that links late; on a Pi the graph alone takes ~100 ms): its packets still
    arrive about 3 ms ahead of their own RTP time, paced one per ms.

    Regression: 0e60966c4. The RTP timeline was anchored when the pipeline was
    built, so every timestamp was early by however long the first audio took
    to arrive. The lead servo answered by moving transmission earlier until
    each buffer was past its render time on arrival: udpsink then sent them as
    they came, a quantum at a time, while the servo -- projecting the send
    time rather than seeing it -- logged +3 ms. On the wire the lead stayed
    at minus the link delay (-910 ms here) for as long as the stream ran."""
    with RtpCapture(5004) as cap:
        start_sender(fppd, audio, link_delay=1.0)
        time.sleep(3)
        pk = window(cap, 8)
    assert len(pk) > 7000, f"{len(pk)} packets in 8 s"
    assert not discontinuities(pk, 48), discontinuities(pk, 48)[:10]
    lead = leads(pk)
    median = statistics.median(lead)
    assert abs(median - TARGET_LEAD_MS) < 1.5 and pct(lead, 0.05) > 0, \
        f"median lead {median:.2f} ms, p5 {pct(lead, 0.05):.2f} ms, max {lead[-1]:.2f} ms\n" + \
        "\n".join(l for l in fppd.log().splitlines() if "servo" in l or "anchored" in l)


def test_source_gaps_are_filled_and_the_lead_held(fppd, audio):
    """The source stops for ~300 ms, three times (its link removed and put
    back, as a group's feed does at a track change): the gap is filled with
    silence, so the RTP timeline never breaks, and the lead returns to the
    servo's target after each.

    Regressions: 31e497515 (a gap was absorbed by re-anchoring, stepping the
    timestamps; now it is filled), 5b6f5880d and cdb9515d4 (the lead ratcheted
    4-7 ms one way per restart and never came back)."""
    with RtpCapture(5004) as cap:
        start_sender(fppd, audio)
        time.sleep(3)
        t0 = time.time_ns()
        for _ in range(3):
            link(audio, NODE, connect=False)
            time.sleep(0.3)
            link(audio, NODE)
            time.sleep(3)
        after = window(cap, 4)
        pk = cap.since(t0)
    gaps = discontinuities(pk, 48)
    assert not gaps, f"seq/timestamp breaks across the gaps (index, dseq, dts): {gaps[:10]}"
    log = fppd.log()
    assert len(re.findall(r"AES67 drift \[1\]: filled [0-9.]+ ms of source gap with silence", log)) >= 3, \
        "\n".join(l for l in log.splitlines() if "AES67" in l)[-3000:]
    median = statistics.median(leads(after))
    assert abs(median - TARGET_LEAD_MS) < 1.5, f"median lead {median:.2f} ms after the gaps"


def thread_scheduling(pid):
    """[(thread name, policy, rt priority)] of every thread of a process."""
    out = []
    for path in glob.glob(f"/proc/{pid}/task/*/stat"):
        try:
            with open(path) as f:
                stat = f.read()
        except OSError:
            continue
        name = stat[stat.index("(") + 1:stat.rindex(")")]
        fields = stat[stat.rindex(")") + 2:].split()
        out.append((name, int(fields[38]), int(fields[37])))
    return out


def test_pacing_thread_runs_realtime(fppd, audio):
    """The thread that paces packets onto the wire runs SCHED_FIFO at 80:
    above ordinary threads, below PipeWire's own 88, so it can never delay
    the graph that feeds it.

    Regression: 33b1e502a. The pacing thread ran with no priority, and the
    jitter tail was other threads getting the CPU first."""
    with RtpCapture(5004):
        start_sender(fppd, audio)
        time.sleep(1)
        threads = thread_scheduling(fppd.proc.pid)
    rt = [t for t in threads if t[1] != 0]
    assert any(t[1] == 1 and t[2] == 80 for t in rt), f"no SCHED_FIFO 80 thread: {rt}"
    assert all(t[2] < 88 for t in rt), f"a thread at or above PipeWire's priority: {rt}"
    assert "pacing thread raised to SCHED_FIFO 80" in fppd.log()


def test_track_changes_do_not_discard_audio(fppd, audio):
    """A playlist of three tones back to back, played into the graph that
    feeds the sender: the tones reach the stream, and no track change makes a
    gap in the sender's source or a break in its RTP timeline.

    Regression: 0a4266e90. Every track change flushed 50 ms of the sender's
    source "as stale", which was the start of the next track: a 150-230 ms
    hole at every transition."""
    from audio import write_tone_wav
    write_tone_wav(fppd.media + "/music/tone.wav", 2)
    fppd.write("playlists/tones.json", {"name": "tones", "repeat": 0, "loopCount": 0,
                                        "mainPlaylist": [{"type": "media", "enabled": 1,
                                                          "playOnce": 0, "mediaName": "tone.wav"}] * 3})
    with RtpCapture(5004) as cap:
        start_sender(fppd, audio)
        time.sleep(2)
        t0 = time.time_ns()
        mark = len(fppd.log())
        fppd.command("Start Playlist", "tones", "false", "false")
        fppd.wait_for(lambda: fppd.log()[mark:].count("GStreamer started playing: tone.wav") >= 3,
                      timeout=30, what="the third track to start")
        time.sleep(3)
        pk = cap.since(t0)
    assert max(p.peak() for p in pk[::10]) > 0.2, "the tones never reached the stream"
    gaps = discontinuities(pk, 48)
    assert not gaps, f"seq/timestamp breaks (index, dseq, dts): {gaps[:10]}"
    log = fppd.log()[mark:]
    source_gaps = [l for l in log.splitlines() if "AES67 source [1]: gap" in l or "source gap" in l]
    assert not source_gaps, source_gaps
