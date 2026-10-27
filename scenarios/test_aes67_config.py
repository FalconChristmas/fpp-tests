"""AES67 (and Opus RTP) send config: what a stored config turns into.

None of these needs audio. The send pipeline's description is logged before
GStreamer parses it, the SDP is built from the config, and with no PipeWire
running a send pipeline fails at once -- which is what the warning scenarios
want. AES67Manager runs only under MediaBackend "pipewire" with an instances
file.
"""

import os
import re
import threading
import time
import urllib.error
import urllib.request

import pytest

from fppd import API

CONFIG = "config/pipewire-aes67-instances.json"
SEND_FAILED = "AES67: audio send stream failed to start"
RECV_FAILED = "AES67: audio receive stream failed to start"
GROUPS_CONF = "/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf"


def write_config(fppd, instances=None, **top):
    # requireGroupSource off: a player's generated audio groups conf feeds
    # none of these senders, and would hold them idle.
    cfg = {"ptpEnabled": False, "ptpInterface": "lo", "ptpLockWaitMs": 0, "requireGroupSource": False,
           "instances": instances if instances is not None else [send()]}
    cfg.update(top)
    fppd.write(CONFIG, cfg)


def send(id=1, name="tx", **kw):
    inst = {"id": id, "name": name, "mode": "send", "enabled": True, "sapEnabled": False,
            "multicastIP": "127.0.0.1", "port": 5004}
    inst.update(kw)
    return inst


def start(fppd):
    fppd.settings(MediaBackend="pipewire")
    fppd.start()
    applied(fppd, 1)


def applied(fppd, n, what="AES67Manager: Applied config"):
    fppd.wait_for(lambda: fppd.log().count(what) >= n, timeout=60, what=f"{what!r} #{n}")


def apply(fppd, done="AES67Manager: Applied config"):
    n = fppd.log().count(done)
    fppd.command("AES67 Apply", timeout=60)
    applied(fppd, n + 1, done)


def send_pipeline(fppd, inst_id=1):
    """The last send pipeline description logged for an instance."""
    found = re.findall(rf"AES67 send pipeline \[{inst_id}\] [^:]*: (pipewiresrc .*)", fppd.log())
    assert found, f"no send pipeline logged for instance {inst_id}"
    return found[-1]


def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def test_send_pipeline_has_the_validated_shape(fppd):
    """A send instance with nothing but its address, on a config with no
    tuning keys at all (requireGroupSource off, as everywhere here), gets
    the configuration validated against receivers:

    - pipewiresrc with min-buffers=16 and always-copy=false, taking the
      source at 48 kHz (no forced graph-rate caps ahead of the resampler);
    - the drift corrector's tap, in F32 with the channel count pinned;
    - one buffer per ptime (audiobuffersplit, 1/1000 at the default 1 ms)
      ahead of the payloader, whose mtu holds one packet;
    - perfect-rtptime=true (the sample counter, anchored to PTP);
    - a time-bounded queue (no 64-buffer cap) feeding a paced sink;
    - and none of the "is set but" warnings, since the defaults agree.

    Regressions: 61d18eb0c -- LoadConfig's literal fallbacks overrode the
    struct defaults, putting always-copy and the graph-rate caps back on.
    36d36f165 (one packet per buffer), 1626747a2 (perfect-rtptime), 5e10052d7
    (a 64-buffer cap sat on top of the steady-state depth at 1 ms and
    silenced the stream). Features pinned: 186e5518a (sinkPacing,
    driftResample, splitClockDomains, sourceSilenceFloor on by default),
    651626859 / 2e977379b (the source pool), d081180ae (libsamplerate drift
    correction), fb77b112b (explicit mtu), 312d823c6 / a6a6ba663 (1 ms ptime
    by default)."""
    fppd.write(CONFIG, {"ptpEnabled": True, "ptpInterface": "lo", "ptpLockWaitMs": 0,
                        "requireGroupSource": False,
                        "instances": [{"id": 1, "name": "tx", "mode": "send",
                                       "multicastIP": "127.0.0.1", "port": 5004}]})
    start(fppd)
    p = send_pipeline(fppd)
    log = fppd.log()
    wanted = [
        "pipewiresrc name=pwsrc min-buffers=16 ",
        " always-copy=false ! audioconvert ",
        "audio/x-raw,format=F32LE,rate=48000,channels=2,channel-mask=(bitmask)0x3 "
        "! identity name=driftpoint",
        "! audiobuffersplit output-buffer-duration=1/1000 ! rtpL24pay ",
        " mtu=1440 min-ptime=1000000 max-ptime=1000000 ",
        " timestamp-offset=0 perfect-rtptime=true ",
        "! queue name=sinkq max-size-bytes=0 max-size-buffers=0 max-size-time=200000000 ! udpsink ",
        " sync=true",
    ]
    # Every difference at once, so one control build shows each cause.
    problems = [f"pipeline lacks {w!r}" for w in wanted if w not in p]
    problems += [f"log lacks {w!r}" for w in ("drift correction on (libsamplerate)",
                                              "split clock domains", "sink pacing on")
                 if w not in log]
    problems += [l for l in log.splitlines() if "is set but" in l]
    assert not problems, "\n".join(problems) + "\n" + p


def test_drift_trim_keeps_the_channel_count(fppd):
    """With the rate-trim element on (adaptiveResample), the caps on both
    sides of it name the stream's channel count.

    Regression: edddd1e14. The element accepts any channel count and nothing
    downstream forced one until the S24BE caps, so it negotiated mono and the
    stream went out as mono upmixed to stereo -- right sizes, right
    timestamps, one channel."""
    write_config(fppd, ptpEnabled=True, adaptiveResample=True)
    start(fppd)
    p = send_pipeline(fppd)
    assert "! audio/x-raw,format=F32LE,channels=2 ! pitch name=drift " \
           "! audio/x-raw,format=F32LE,channels=2 " in p, p


def test_multichannel_pipeline_names_its_layout(fppd):
    """An 8-channel sender names the channel layout (channel-mask 0xc3f) in
    both caps and copies source buffers.

    Regressions: 53a4d7480 -- above stereo, caps without a channel-mask never
    negotiate, so not one packet went out ("Internal data stream error").
    90891c059 -- without always-copy an 8-channel stream sent most packets
    back to back. (test_aes67_wire.py checks the packets themselves.)"""
    write_config(fppd, ptpEnabled=True, instances=[send(channels=8)])
    start(fppd)
    p = send_pipeline(fppd)
    problems = []
    if " always-copy=true " not in p:
        problems.append("no always-copy at 8 channels")
    for caps in ("audio/x-raw,format=F32LE,rate=48000,channels=8,channel-mask=(bitmask)0xc3f ",
                 "audio/x-raw,format=S24BE,rate=48000,channels=8,channel-mask=(bitmask)0xc3f "):
        if caps not in p:
            problems.append(f"no {caps!r}")
    assert not problems, "\n".join(problems) + "\n" + p


def test_incoherent_tuning_flags_are_warned(fppd):
    """Flags that only work together are reported at load when set apart:
    sourceSilenceFloor without driftResample, and splitClockDomains without
    ptpMediaClock, without PTP, or without sinkPacing.

    Regressions: ac9b237b0 and 72ccebeff. A partial set failed quietly in
    ways that looked like other bugs (a whole quantum bursting at once, with
    payload and timestamps perfect)."""
    write_config(fppd, ptpEnabled=False, ptpMediaClock=False, sinkPacing=False,
                 driftResample=False, splitClockDomains=True, sourceSilenceFloor=True)
    start(fppd)
    log = fppd.log()
    for warning in ("sourceSilenceFloor is set but driftResample is not",
                    "splitClockDomains is set but ptpMediaClock is not",
                    "splitClockDomains is set but PTP is disabled",
                    "splitClockDomains is set but sinkPacing is not"):
        assert warning in log, f"not warned: {warning}"


def http(path):
    """(status, headers, body) of a GET to fppd, including error replies."""
    try:
        with urllib.request.urlopen(API + path, timeout=10) as r:
            return r.status, r.headers, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode()


def test_sdp_export_of_stored_instances(fppd):
    """/aes67/sdp describes each send instance as a receiver needs it, from
    the config alone:

    - an instance stored with 16 channels and no ptime is clamped to the 8
      the graph carries (and says so) at the 1 ms default;
    - an 8-channel instance stored at 4 ms is clamped to the 1 ms that fits
      one 1440-byte packet;
    - /aes67/sdp/<id> is the raw application/sdp with a download filename,
      an unknown id is a 404, and a receive-only instance has no SDP;
    - the session's o= line is the same after an Apply and after a restart.

    Features: a33868385 (SDP export), 312d823c6 and 53a4d7480 (channel
    limit, now 8), a6a6ba663 (1 ms default), fb77b112b (one ptime fits one
    packet), 989edbd88 (a=mediaclk:direct=0 and a stable session identity)."""
    write_config(fppd, ptpEnabled=True, instances=[
        send(1, "Wide Stream", channels=16),
        send(2, "eight", channels=8, ptime=4, port=5006),
        {"id": 3, "name": "rx", "mode": "receive", "enabled": False, "sapEnabled": False,
         "multicastIP": "127.0.0.1", "port": 5008}])
    start(fppd)
    log = fppd.log()
    assert "instance 'Wide Stream' asks for 16 channels" in log
    assert "instance 'eight' asks for 4ms ptime at 8 channels" in log

    streams = {s["instanceId"]: s for s in fppd.get("/aes67/sdp")["streams"]}
    assert sorted(streams) == [1, 2], streams
    one, two = streams[1], streams[2]
    assert (one["channels"], one["ptime"], two["channels"], two["ptime"]) == (8, 1, 8, 1), streams
    for s in (one, two):
        sdp = s["sdp"]
        assert "a=rtpmap:96 L24/48000/8\r\n" in sdp and "a=ptime:1\r\n" in sdp, sdp
        assert "a=mediaclk:direct=0\r\n" in sdp, sdp
        assert re.search(r"a=ts-refclk:ptp=IEEE1588-2008:[0-9A-F-]{23}:0\r\n", sdp), sdp

    status, headers, body = http("/aes67/sdp/1")
    assert status == 200 and headers["Content-Type"].startswith("application/sdp"), (status, dict(headers))
    assert 'filename="wide_stream.sdp"' in headers.get("Content-Disposition", ""), dict(headers)
    assert body == one["sdp"]
    assert http("/aes67/sdp/99")[0] == 404
    assert http("/aes67/sdp/3")[0] == 404

    def origins():
        return [s["sdp"].split("\r\n")[1] for s in fppd.get("/aes67/sdp")["streams"]]
    before = origins()
    assert before[0] != before[1], "two streams share a session id"
    apply(fppd)
    assert origins() == before, "the o= line changed on an Apply"
    assert fppd.stop() == 0
    fppd.start()
    applied(fppd, 1)
    assert origins() == before, "the o= line changed across a restart"


@pytest.fixture
def two_addresses():
    """Two dummy interfaces, each with an address of its own, standing for
    the network ports of two different boxes. Needs CAP_NET_ADMIN in fppd's
    network namespace (the test container, or run-local.sh's private one)."""
    import shutil
    import subprocess
    if not shutil.which("ip"):
        pytest.skip("needs iproute2")
    made = []
    try:
        for i, addr in enumerate(("192.0.2.11", "192.0.2.12")):
            name = f"fpptst{i}"
            r = subprocess.run(["ip", "link", "add", name, "type", "dummy"], capture_output=True, text=True)
            if r.returncode:
                pytest.skip(f"can't make a dummy interface: {r.stderr.strip()}")
            made.append(name)
            subprocess.run(["ip", "addr", "add", addr + "/32", "dev", name], check=True)
            subprocess.run(["ip", "link", "set", name, "up"], check=True)
        yield {name: addr for name, addr in zip(made, ("192.0.2.11", "192.0.2.12"))}
    finally:
        for name in made:
            subprocess.run(["ip", "link", "del", name], capture_output=True)


def test_session_ids_differ_by_device_and_by_stream(fppd, two_addresses):
    """Three send instances with one name: two with the same multicast
    group and port on interfaces with different addresses -- the same
    stream config as two boxes would send it -- and a third on another
    port. Each one's SDP carries its own o= session id.

    Regression: b2730fcae. The session id was a hash of the stream's name
    alone, so every box announcing a stream of the same name -- and every
    stream of one name on a box -- claimed the same session, and a receiver
    keeps only one of them."""
    (if_a, addr_a), (if_b, addr_b) = two_addresses.items()
    write_config(fppd, instances=[
        send(1, "tx", interface=if_a),
        send(2, "tx", interface=if_b),
        send(3, "tx", interface=if_a, port=5006)])
    start(fppd)
    origins = {s["instanceId"]: s["sdp"].split("\r\n")[1].split()
               for s in fppd.get("/aes67/sdp")["streams"]}
    assert sorted(origins) == [1, 2, 3], origins
    # o=- <sess-id> <sess-version> IN IP4 <address>
    assert (origins[1][5], origins[2][5]) == (addr_a, addr_b), f"precondition: source addresses {origins}"
    ids = {i: o[1] for i, o in origins.items()}
    assert len(set(ids.values())) == 3, f"session ids shared: {ids}"


def test_stream_failure_warnings_come_down_when_fixed(fppd):
    """A send and a receive stream that cannot start (no PipeWire) each raise
    their warning; disabling them and applying takes both down.

    Regression: d7ea87da7. Nothing retracted these warnings, which have no
    timeout, so the banner said a stream had failed until fppd restarted."""
    write_config(fppd, instances=[
        send(),
        {"id": 2, "name": "rx", "mode": "receive", "enabled": True, "sapEnabled": False,
         "multicastIP": "127.0.0.1", "port": 5006}])
    start(fppd)
    w = warnings(fppd)
    assert SEND_FAILED in w and RECV_FAILED in w, w
    write_config(fppd, instances=[send(enabled=False)])
    apply(fppd, "AES67Manager: No enabled instances")
    w = warnings(fppd)
    assert SEND_FAILED not in w and RECV_FAILED not in w, w


@pytest.fixture
def groups_conf():
    """Writes the Audio Output Groups conf the group pages generate, which is
    what decides whether anything feeds a network sender. Only inside the
    test container, where there is none."""
    if not os.path.exists("/etc/fpp/container"):
        pytest.skip("writes /etc/pipewire: only inside the test container")
    if os.path.exists(GROUPS_CONF):
        pytest.skip("this machine has a generated audio groups conf")
    made = []
    d = os.path.dirname(GROUPS_CONF)
    for parent in (os.path.dirname(d), d):
        if not os.path.isdir(parent):
            os.mkdir(parent)
            made.append(parent)

    def write(*targets):
        with open(GROUPS_CONF, "w") as f:
            f.write("context.modules = [\n")
            for t in targets:
                f.write(f'  {{ name = libpipewire-module-loopback args = {{ playback.props = '
                        f'{{ node.target = "{t}" }} }} }}\n')
            f.write("]\n")
    try:
        yield write
    finally:
        if os.path.exists(GROUPS_CONF):
            os.unlink(GROUPS_CONF)
        for d in reversed(made):
            os.rmdir(d)


def test_unfed_senders_are_held_idle(fppd, groups_conf):
    """An AES67 and an Opus RTP sender that no Audio Output Group feeds are
    held idle: no pipeline is tried (it would block the apply for 30 s and
    fail), no failure warning, and each status lists the sender as waiting
    for audio. Once a group targets each of them, an Apply starts them.

    Regression: 549b41a93 (Opus RTP) and Feature: 22a811f10 (AES67). Before
    them every apply started such a sender, blocked, and ended in the
    "failed to start" warning for a stream that was simply not routed yet."""
    groups_conf("fpp_alsa_card0")
    write_config(fppd, requireGroupSource=True)
    fppd.write("config/pipewire-opus-rtp-instances.json", {"instances": [
        {"id": 1, "name": "op", "mode": "send", "enabled": True, "destIP": "127.0.0.1",
         "port": 5006}]})
    start(fppd)
    applied(fppd, 1, "OpusRTPManager: Applied config")

    def waiting(path):
        return [p for p in fppd.get(path)["pipelines"] if p.get("waitingForSource")]
    problems = []
    for path in ("/aes67/status", "/opusrtp/status"):
        held = waiting(path)
        if not (len(held) == 1 and held[0]["instanceId"] == 1 and held[0]["note"]):
            problems.append(f"{path} lists no sender waiting for audio: {fppd.get(path)}")
    log = fppd.log()
    for what in ("AES67 send pipeline [1]", "Opus RTP send pipeline [1]"):
        if what in log:
            problems.append(f"tried anyway: {what}")
    if SEND_FAILED in warnings(fppd):
        problems.append("send failure warning raised")
    assert not problems, "\n".join(problems)

    groups_conf("aes67_tx_send", "opusrtp_op_send")
    apply(fppd)
    n = fppd.log().count("OpusRTPManager: Applied config")
    fppd.command("Opus RTP Apply", timeout=60)
    applied(fppd, n + 1, "OpusRTPManager: Applied config")
    log = fppd.log()
    assert "AES67 send pipeline [1]" in log and "Opus RTP send pipeline [1]" in log
    assert not waiting("/aes67/status") and not waiting("/opusrtp/status")


def test_status_while_config_is_applied(fppd):
    """Status and SDP requests from several threads while the AES67 and Opus
    RTP configs are rewritten and applied over and over: every request is
    answered, and (under TSan) nothing races.

    Coverage for cc5e188a6, which moved every config read on an HTTP thread
    to a snapshot taken under a lock; before it a status query iterated the
    instance list while LoadConfig() rebuilt it."""
    write_config(fppd)
    fppd.write("config/pipewire-opus-rtp-instances.json", {"instances": [
        {"id": 1, "name": "op", "mode": "send", "enabled": True, "destIP": "127.0.0.1",
         "port": 5006}]})
    start(fppd)
    stop = threading.Event()
    errors = []

    def poll():
        while not stop.is_set():
            for path in ("/aes67/status", "/aes67/sdp", "/opusrtp/status"):
                try:
                    fppd.get(path)
                except Exception as e:
                    errors.append(f"{path}: {e}")
                    return
    threads = [threading.Thread(target=poll) for _ in range(4)]
    for t in threads:
        t.start()
    try:
        deadline = time.monotonic() + 20
        i = 0
        while time.monotonic() < deadline and not errors:
            i += 1
            write_config(fppd, instances=[send(n, f"s{n}") for n in range(1, 2 + i % 4)])
            fppd.write("config/pipewire-opus-rtp-instances.json", {"instances": [
                {"id": n, "name": f"o{n}", "mode": "send", "enabled": True,
                 "destIP": "127.0.0.1", "port": 5006 + n} for n in range(1, 2 + i % 3)]})
            fppd.command("AES67 Apply", timeout=60)
            fppd.command("Opus RTP Apply", timeout=60)
    finally:
        stop.set()
        for t in threads:
            t.join()
    assert not errors, errors
    assert i >= 3, f"only {i} applies in 20 s"
