"""A show that keeps running into the same problem must not write the log
every frame. Devices log to an SD card or eMMC: a line per frame is
20-100 lines a second for the length of the show, which wears the card and
buries everything else in the log. Each problem is logged once (or now and
then) and, where a user can act on it, shown as a warning.
"""

import contextlib
import subprocess
import time

import pytest

from fseq import unique_frames
from show import CHANNELS, install

# Nothing answers here, and unreachable() takes away any route to it, so
# every send to it fails.
NOWHERE = "10.77.0.9"


@contextlib.contextmanager
def unreachable(address):
    """No route to `address`: sends to it fail with EHOSTUNREACH. run-local's
    loopback-only namespace has no route there anyway, but the container has
    a default route, where the send would simply go to the gateway."""
    r = subprocess.run(["ip", "route", "add", "unreachable", address + "/32"],
                       capture_output=True, text=True)
    if r.returncode:
        pytest.skip(f"cannot add an unreachable route: {r.stderr.strip()}")
    try:
        yield
    finally:
        subprocess.run(["ip", "route", "del", "unreachable", address + "/32"])


def log_size(fppd):
    """fppd.log plus fppd's stdout (where printf and, under systemd, the
    journal get their lines)."""
    import os
    stdout = os.path.join(fppd.media, "logs", "fppd.stdout")
    return len(fppd.log()) + (os.path.getsize(stdout) if os.path.exists(stdout) else 0)


def log_growth(fppd, seconds=5, during=None):
    """Bytes logged over `seconds`, optionally while `during()` runs."""
    start = log_size(fppd)
    t0 = time.monotonic()
    if during:
        during()
    time.sleep(max(0, seconds - (time.monotonic() - t0)))
    return log_size(fppd) - start


def flood(port, packets, count=300, seconds=3, host="127.0.0.1"):
    """Send `packets` (cycled) `count` times over `seconds`."""
    import socket
    def run():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for i in range(count):
            s.sendto(packets[i % len(packets)], (host, port))
            time.sleep(seconds / count)
        s.close()
    return run


def play(fppd):
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                  what="the show to play")
    time.sleep(1)  # past whatever is logged once as it starts


def test_unreachable_multisync_remote(fppd):
    """A master with a unicast remote that is not there fails to send it
    every sync packet; that is logged when it starts and then once a minute,
    not for each packet (about two lines a second, 1.4 MB of log an hour).
    Regression: fixed by a00caa85d."""
    install(fppd, unique_frames(1200, CHANNELS))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=NOWHERE)
    with unreachable(NOWHERE):
        fppd.start()
        play(fppd)
        start = fppd.log().count("Unable to send multisync packet")
        time.sleep(5)
        lines = fppd.log().count("Unable to send multisync packet") - start
    assert lines == 0, f"{lines} lines about the unreachable MultiSync remote in 5 s"


@pytest.mark.parametrize("kind", ["E1.31", "DDP"])
def test_unreachable_controller(fppd, kind):
    """An output to a controller that is not there (and not pinged) fails
    every send; that is logged now and then, not each frame.

    Regression: 2ac813fce. Each failed send was logged, every frame: about
    40 KB of log in 5 s here."""
    install(fppd, unique_frames(1200, CHANNELS))
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": CHANNELS,
        "universes": [{"active": 1, "description": "gone", "id": 1, "startChannel": 1,
                       "channelCount": CHANNELS, "type": 1 if kind == "E1.31" else 5,
                       "address": NOWHERE, "priority": 0, "monitor": 0, "deDuplicate": 0}],
    }]})
    with unreachable(NOWHERE):
        fppd.start()
        play(fppd)
        grew = log_growth(fppd)
    assert grew < 2000, f"fppd.log grew {grew} bytes in 5 s with the {kind} controller unreachable"


def test_playlist_of_missing_sequences(fppd):
    """A repeating playlist whose sequence files aren't there (copied to a
    player without its fseqs) logs each missing file once, not each time
    it comes round -- 150 KB of log every 5 s before 9f4c82e1b."""
    from show import playlist, sequence_entry
    fppd.write("playlists/Gone.json", playlist(
        "Gone", [sequence_entry(f"missing{i}.fseq") for i in range(6)]))
    fppd.start()
    fppd.command("Start Playlist", "Gone", "true", "false")
    time.sleep(2)
    grew = log_growth(fppd)
    assert grew < 3000, f"fppd.log grew {grew} bytes in 5 s with a playlist of missing sequences"


def test_truncated_sequence(fppd):
    """An uncompressed FSEQ cut short (an interrupted upload) plays what it
    has; the frames past the end of the file are reported once, not once
    per frame (before 17c9ad562)."""
    import os
    from fseq import write_fseq_reference
    frames = unique_frames(1200, CHANNELS)
    install(fppd, frames[:2])
    path = os.path.join(fppd.media, "sequences", "Show.fseq")
    write_fseq_reference(path, frames)
    with open(path, "r+b") as f:
        f.truncate(os.path.getsize(path) // 10)  # 6 s of a 60 s sequence
    fppd.start()
    fppd.command("Start Playlist", "Show", "false", "false")
    time.sleep(8)  # well past the end of the data
    grew = log_growth(fppd)
    assert grew < 2000, f"fppd.log grew {grew} bytes in 5 s playing past the end of a truncated sequence"


def test_malformed_multisync_packets(fppd):
    """Junk on the MultiSync port (another program, a version mismatch) is
    not logged -- with a hex dump -- once per packet (120 KB for 300 packets
    before 78370c14d)."""
    from multisync import PORT
    junk = [b"", b"FPPD", b"FPPD\x01\xff\xff", b"hello world" * 10, b"FPPD\x63\x05\x00abcde",
            b"FPPD\x01\x02\x00\x02\x00"]
    fppd.settings(MultiSyncEnabled="1")
    fppd.start()
    grew = log_growth(fppd, during=flood(PORT, junk))
    # the first few each minute are still logged, with a hex dump each
    assert grew < 10000, f"fppd logged {grew} bytes for 300 malformed MultiSync packets"


def test_ddp_packets_that_are_not_data(fppd):
    """DDP query/reply or other non-data packets to the bridge are not
    printed to stdout (the journal, under systemd) one by one (before
    ae3250a39)."""
    import struct
    packets = [bytes([0x41, 0x00, 0x01, 0xFF]) + struct.pack(">IH", 0, 0),
               bytes([0x43, 0x00, 0x01, 0xFA]) + struct.pack(">IH", 0, 0),
               bytes([0x43, 0x00, 0x01, 0xFB]) + struct.pack(">IH", 0, 0)]
    # a DDP input: without one the port is held only to warn that data arrived
    fppd.write("config/ci-universes.json", {"channelInputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 512,
        "universes": [{"active": 1, "id": 1, "startChannel": 1, "size": 512, "type": 1,
                       "priority": 0, "address": ""}]}]})
    fppd.start()
    grew = log_growth(fppd, during=flood(4048, packets))
    assert grew < 3000, f"fppd logged {grew} bytes for 300 non-data DDP packets"


def test_remote_told_to_play_a_name_it_refuses(fppd):
    """A remote whose master keeps naming a sequence it won't open (a name
    with ".." in it) reports that once, not on every sync packet (before
    9f4c82e1b)."""
    from multisync import PORT, sync_packet
    fppd.settings(fppMode="remote")
    fppd.start()
    pkts = [sync_packet(a, "fseq", f, f * 0.05, "x..y.fseq")
            for a, f in (("open", 0), ("start", 0), ("sync", 10), ("sync", 20))]
    grew = log_growth(fppd, during=flood(PORT, pkts, count=60, seconds=3))
    assert grew < 2000, f"fppd logged {grew} bytes for 60 sync packets naming a refused file"


def test_lor_output_over_its_channel_limit(fppd):
    """A LOR output configured past what LOR can address (3840 channels) is
    refused or reported once, not logged every frame (before 832b07ba0)."""
    from serial import PtyReader
    with PtyReader() as pty:
        install(fppd, unique_frames(1200, CHANNELS))
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "LOR", "enabled": 1, "startChannel": 1, "channelCount": 4000,
            "device": pty.device, "speed": 19200, "firstControllerId": 1}]})
        fppd.start()
        play(fppd)
        grew = log_growth(fppd)
    assert grew < 2000, f"fppd.log grew {grew} bytes in 5 s with a LOR output over its limit"


def test_submodel_outside_its_parent_with_an_effect(fppd):
    """A submodel that lies outside its parent (the parent was resized after
    the submodel was saved) is warned about once; running an effect on it
    does not log "out of bounds" every frame (before 7713c73b1)."""
    from test_overlays import CHANNELS as OCH, effect, matrix, setup, submodel
    setup(fppd, [matrix(), submodel("Off", "M", 8, 0, 5, 3)])  # M is 10 wide
    fppd.start()
    effect(fppd, "Off", "Bars", Direction="Down")
    time.sleep(1)
    grew = log_growth(fppd)
    assert grew < 2000, f"fppd.log grew {grew} bytes in 5 s with an effect on an out-of-bounds submodel"


def test_mqtt_output_with_a_wildcard_topic(fppd):
    """An MQTT channel output whose topic holds a wildcard (+ or #) -- which
    no broker accepts for a publish -- is refused once at start, not
    logged on every value it tries to send (before e1c2d756b)."""
    import shutil
    import subprocess
    if not shutil.which("mosquitto"):
        pytest.skip("mosquitto is not installed")
    port = "18831"
    broker = subprocess.Popen(["mosquitto", "-p", port], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(0.5)
        install(fppd, unique_frames(1200, CHANNELS))
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "MQTTOutput", "enabled": 1, "startChannel": 1, "channelCount": 3,
            "topic": "lights/+/set", "payload": "%R%,%G%,%B%", "channelType": "RGB"}]})
        fppd.settings(MQTTHost="127.0.0.1", MQTTPort=port)
        fppd.start()
        play(fppd)
        grew = log_growth(fppd)
    finally:
        broker.terminate()
    assert grew < 2000, f"fppd.log grew {grew} bytes in 5 s with a wildcard MQTT output topic"


def test_wled_api_out_of_descriptors(fppd):
    """With fppd out of file descriptors and connections queued on the WLED
    API's port, accept() fails at once every time it is called; that is
    logged now and then, not on each pass of a loop that never waits.

    Regression: bf5fae81c (WV-7). The accept loop logged the failure and
    went straight back to accept(): it spun a core writing a line a spin."""
    import os
    import resource
    import socket
    from test_wled_api import PORT, start
    start(fppd)
    pid = fppd.proc.pid
    old = resource.prlimit(pid, resource.RLIMIT_NOFILE)
    conns = []
    try:
        resource.prlimit(pid, resource.RLIMIT_NOFILE,
                         (len(os.listdir(f"/proc/{pid}/fd")) + 4, old[1]))
        for _ in range(12):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setblocking(False)
            s.connect_ex(("127.0.0.1", PORT))
            conns.append(s)
        time.sleep(0.5)
        grew = log_growth(fppd, seconds=3)
    finally:
        for s in conns:
            s.close()
        resource.prlimit(pid, resource.RLIMIT_NOFILE, old)
    assert grew < 2000, f"fppd.log grew {grew} bytes in 3 s with the WLED API out of descriptors"
