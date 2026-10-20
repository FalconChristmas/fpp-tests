"""MultiSync, both sides: fppd as master (what it announces, captured off the
loopback interface) and as remote (driven by sync packets this test sends)."""

import socket
import time

import pytest

from capture import UdpCapture
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from multisync import PORT, parse_sync, sync_packet
from show import CHANNELS, ddp_output, install, status
from test_multisync_systems import interface

STEP_MS = 50
REMOTE = "127.0.0.2"


def test_master_announces_what_it_plays(fppd):
    """As master, fppd tells its remotes to open and start the sequence,
    keeps them in sync with frame numbers that match its own output, and
    tells them to stop.

    - open, then start, both at frame 0, naming the sequence;
    - sync packets with strictly increasing frames, no more than 10 apart,
      whose seconds field is frame x step time;
    - each sync's frame within 2 of what the master's own lights showed at
      that moment;
    - stop after Stop Now, then blanking.
    """
    frames = unique_frames(400, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    with UdpCapture(PORT, REMOTE) as cap, DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE)
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        time.sleep(5)
        fppd.command("Stop Now")
        time.sleep(1.5)
        packets = cap.snapshot()
        wire = [(t, lookup.get(d[:CHANNELS])) for t, d in rx.snapshot()]

    syncs = [s for s in (parse_sync(t, p) for t, _, _, p in packets) if s]
    ours = [s for s in syncs if s.filename == "Show.fseq" and s.file_type == "fseq"]
    actions = [s.action for s in ours]
    assert actions[:2] == ["open", "start"], f"sequence of announcements: {actions[:6]}"
    assert ours[0].frame == 0 and ours[1].frame == 0, ours[:2]
    assert actions[-1] == "stop", f"last announcement was {actions[-1]}"

    beats = [s for s in ours if s.action == "sync"]
    assert len(beats) >= 8, f"only {len(beats)} sync packets in 5 s"
    for a, b in zip(beats, beats[1:]):
        assert b.frame > a.frame, f"sync frames went from {a.frame} to {b.frame}"
        assert b.frame - a.frame <= 10, f"sync gap of {b.frame - a.frame} frames"
    for s in beats:
        assert abs(s.seconds - s.frame * STEP_MS / 1000) < 0.002, \
            f"frame {s.frame} announced as {s.seconds:.3f} s"
        shown = [i for t, i in wire if t <= s.time and i is not None]
        if not shown and s.frame <= 2:
            continue  # sent as playback began, before the first frame reached the wire
        assert shown and abs(shown[-1] - s.frame) <= 2, \
            f"sync said frame {s.frame} while the master showed {shown[-1] if shown else None}"

    stop_at = next(s.time for s in ours if s.action == "stop")
    blanks = [t for t, _, _, p in packets if p[:4] == b"FPPD" and p[4] == 0x03 and t >= stop_at]
    assert blanks, "no blanking packet after stop"


def test_remote_follows_its_master(fppd):
    """As remote, fppd plays what sync packets tell it to: it opens and
    starts the sequence, its output follows the master's frame numbers
    (including a jump), and it stops and goes dark on stop."""
    frames = unique_frames(600, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(f"{fppd.media}/sequences/Show.fseq", frames, step_ms=STEP_MS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(action, frame=0):
        sock.sendto(sync_packet(action, "fseq", frame, frame * STEP_MS / 1000, "Show.fseq"),
                    ("127.0.0.1", PORT))

    def shown_since(t):
        return [lookup.get(d[:CHANNELS]) for tt, d in rx.snapshot(since=t)]

    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        assert status(fppd).get("mode_name") == "remote", status(fppd).get("mode_name")
        send("open")
        time.sleep(0.5)
        send("start")
        began = time.monotonic()
        for _ in range(8):
            time.sleep(0.5)
            frame = round((time.monotonic() - began) * 1000 / STEP_MS)
            send("sync", frame)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=5,
                      what="the remote to report playing")
        assert status(fppd).get("current_sequence") == "Show.fseq", status(fppd)
        now_frame = round((time.monotonic() - began) * 1000 / STEP_MS)
        recent = [i for i in shown_since(time.monotonic() - 0.3) if i is not None]
        assert recent and abs(recent[-1] - now_frame) <= 4, \
            f"remote showing frame {recent[-1] if recent else None}, master at {now_frame}"

        # The master jumps ahead (a seek, or a master restarted mid-show).
        jumped = time.monotonic()
        for k in range(6):
            send("sync", 400 + k * 10)
            time.sleep(0.5)
        later = [i for i in shown_since(jumped + 1.0) if i is not None]
        assert later and min(later) >= 390, \
            f"remote did not follow the jump to frame 400: showed {later[:5]}"

        send("stop")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                      what="the remote to stop")
        time.sleep(0.5)
        assert not any(rx.last()), "the remote's output was left lit after stop"
    sock.close()


def test_sync_destinations_change_without_a_restart(fppd):
    """Changing the unicast remote list while a sequence plays moves the
    sync packets to the new remote and away from the old one, without
    restarting fppd; a remote given by host name is sent to at its
    address, not broadcast.

    Regression: 3d0f12825 (destinations were built once at startup, and
    host names became 255.255.255.255). Fails on a tree from before it.
    """
    frames = unique_frames(1200, CHANNELS)
    with UdpCapture(PORT) as cap:
        install(fppd, frames, step_ms=STEP_MS)
        fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes="127.0.0.2")
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        time.sleep(2)
        changed = time.monotonic()
        fppd.settings(MultiSyncRemotes="localhost")
        time.sleep(3)
        packets = cap.snapshot()
    syncs = [(t, dst) for t, _, dst, p in packets if parse_sync(t, p)]
    before = {dst for t, dst in syncs if t < changed}
    after = {dst for t, dst in syncs if t > changed + 1.0}
    assert "127.0.0.2" in before, f"sync went to {before} before the change"
    assert "127.0.0.1" in after, f"sync went to {after} after the change to localhost"
    assert "127.0.0.2" not in after, "sync still went to the old remote after the change"


def test_settings_file_change_to_a_multisync_setting(fppd):
    """The settings file rewritten under a running fppd with a MultiSync
    remote list changed, again and again: MultiSync's listener rebuilds its
    destinations each time. Only a TSan build can tell: it reports the lock
    cycle.

    Regression: e1bee3f47. Listeners ran under the listeners lock, which a
    settings reload takes while it holds the settings lock, and MultiSync's
    listener takes its own lock and then reads a setting: a three-lock
    cycle."""
    frames = unique_frames(400, CHANNELS)
    install(fppd, frames, step_ms=STEP_MS)
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes="127.0.0.2")
    fppd.start()
    fppd.command("Start Playlist", "Show", "false", "false")
    for n in range(3, 8):
        time.sleep(1.1)  # a change the file monitor sees as a new write
        fppd.settings(MultiSyncRemotes=f"127.0.0.{n}")
    time.sleep(1.5)
    fppd.get("/fppd/status")


QUOTED_REMOTES = ["127.0.0.2", "127.0.0.3", "127.0.0.4"]
# As each is stored in the value: the old MultiSync page PUT MultiSyncRemotes as
# a JSON string (the whole list in quotes), and a list typed with its own quotes
# has them on every entry.
QUOTED_LISTS = {
    "whole_list_quoted": '"127.0.0.2,127.0.0.3,127.0.0.4"',
    "each_entry_quoted": '"127.0.0.2","127.0.0.3","127.0.0.4"',
}


@pytest.mark.parametrize("setting", ["MultiSyncRemotes", "MultiSyncExtraRemotes"])
@pytest.mark.parametrize("stored", QUOTED_LISTS.values(), ids=QUOTED_LISTS.keys())
def test_quoted_remote_list_reaches_every_remote(fppd, setting, stored):
    """A remote list stored with quotes in its value syncs every remote on
    it, including the entries the quotes are attached to.

    Regression: 95314fd4c and f34baf9ec. The MultiSync page PUT its list as
    a JSON string from 2021 until 95314fd4c, and once the settings loader
    stopped stripping every quote (e4ada58de), fppd read the first entry as
    "127.0.0.2 and the last as 127.0.0.4" and synced neither. 95314fd4c
    stripped the outer quotes from the whole list first, which turned a list
    with quoted entries into 127.0.0.2","127.0.0.3","127.0.0.4: none of
    those parsed. f34baf9ec strips a quote from each end of each entry.
    """
    frames = unique_frames(400, CHANNELS)
    with UdpCapture(PORT) as cap:
        install(fppd, frames, step_ms=STEP_MS)
        fppd.settings(MultiSyncEnabled="1", **{setting: stored})
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        time.sleep(3)
        packets = cap.snapshot()
    synced = {dst for t, _, dst, p in packets if parse_sync(t, p)}
    missing = [r for r in QUOTED_REMOTES if r not in synced]
    assert not missing, f"no sync packets reached {missing}; they went to {sorted(synced)}"


@pytest.mark.parametrize("stored", QUOTED_LISTS.values(), ids=QUOTED_LISTS.keys())
def test_discover_ping_reaches_every_quoted_extra_remote(fppd, stored):
    """The discover ping fppd sends at startup reaches every host on
    MultiSyncExtraRemotes, whose quotes are stripped by the same rule as the
    sync list's above.

    Regression: f34baf9ec. The discover ping split the list without
    stripping any quotes, so the quoted entries got no discover ping at all,
    while sync packets reached them. (fppd describes itself from a
    non-loopback address, so a dummy interface gives it one.)
    """
    def discovered():
        return {dst for _, _, dst, p in cap.snapshot()
                if len(p) > 8 and p[4] == 0x04 and p[8] == 1}

    with interface("10.77.0.1"), UdpCapture(PORT) as cap:
        fppd.settings(MultiSyncExtraRemotes=stored)
        fppd.start()
        try:
            fppd.wait_for(lambda: set(QUOTED_REMOTES) <= discovered(), timeout=5,
                          what="a discover ping to every extra remote")
        except TimeoutError:
            pass
        got = discovered()
    missing = [r for r in QUOTED_REMOTES if r not in got]
    assert not missing, f"no discover ping reached {missing}; pings went to {sorted(got)}"


def test_empty_list_from_the_old_page_falls_back_to_multicast(fppd):
    """A master with no send method chosen and no remotes multicasts its
    sync packets, and an empty list saved by the old MultiSync page (a bare
    pair of quotes, from PUTting "" as a JSON string) counts as no remotes.

    The quotes counted as a list before 95314fd4c, so that master sent its
    sync packets nowhere. f34baf9ec moved the check from the joined list to
    the parsed one and has to keep this. fppd multicasts on its non-loopback
    interfaces only, so the packets are captured leaving a dummy one.
    """
    frames = unique_frames(400, CHANNELS)
    with interface("10.77.0.1"), UdpCapture(PORT, "239.70.80.80", iface="fpptest0") as cap:
        install(fppd, frames, step_ms=STEP_MS)
        # Unicast to every known remote is on by default: off, nothing is chosen
        fppd.settings(MultiSyncEnabled="1", MultiSyncUnicast="0", MultiSyncRemotes='""')
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        time.sleep(3)
        syncs = [s for s in (parse_sync(t, p) for t, _, _, p in cap.snapshot()) if s]
    assert syncs, "no sync packets were multicast"


def parse_fpp_command(payload):
    """An FPP Command control packet: (host, command, args), or None."""
    if len(payload) < 8 or payload[:4] != b"FPPD" or payload[4] != 6:
        return None
    n = payload[7]
    fields = payload[8:].split(b"\0")
    host, cmd, args = fields[0].decode(), fields[1].decode(), [f.decode() for f in fields[2:2 + n]]
    return host, cmd, args


def variable(fppd, name):
    return (fppd.get("/variables") or {}).get(name, {}).get("value")


def test_master_sends_multisync_commands(fppd):
    """A command flagged MultiSync goes to the remotes as an FPP Command
    packet with its %VAR: values filled in here (a remote can't resolve this
    host's variables): targeted at one host, it is sent to that host and
    not run here; with no host, it is broadcast and run here too."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE, DisableFakeNetworkBridges="1")
    with UdpCapture(PORT, REMOTE) as cap:
        fppd.start()
        fppd.command("Set Variable", "Src", "Value", "forty-two", "1", "0", "100", "")
        fppd.post("/command", {"command": "Set Variable", "multisyncCommand": True,
                               "multisyncHosts": REMOTE,
                               "args": ["Targeted", "Value", "%VAR:Src%", "1", "0", "100", ""]})
        fppd.post("/command", {"command": "Set Variable", "multisyncCommand": True,
                               "multisyncHosts": "",
                               "args": ["Everyone", "Value", "all", "1", "0", "100", ""]})
        time.sleep(1)
        sent = [c for c in (parse_fpp_command(p) for _, _, _, p in cap.snapshot()) if c]
    assert (REMOTE, "Set Variable", ["Targeted", "Value", "forty-two", "1", "0", "100", ""]) in sent, sent
    assert ("", "Set Variable", ["Everyone", "Value", "all", "1", "0", "100", ""]) in sent, sent
    assert variable(fppd, "Targeted") is None, "a command for another host ran here"
    assert variable(fppd, "Everyone") == "all", "a command for every host didn't run here"


@pytest.mark.parametrize("entry_type", ["both", "media"])
def test_master_announces_its_media(fppd, audio, entry_type):
    """A master playing media tells its remotes about the media as well:
    open and start naming the file, sync packets whose position advances
    with the clock, and stop when it ends."""
    import os
    from audio import write_tone_wav
    from show import playlist
    secs = 5
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), secs)
    entry = {"type": entry_type, "enabled": 1, "playOnce": 0, "mediaName": "Song.wav"}
    if entry_type == "both":
        write_fseq(f"{fppd.media}/sequences/Song.fseq", unique_frames(secs * 20, CHANNELS), step_ms=STEP_MS)
        entry["sequenceName"] = "Song.fseq"
    fppd.write("playlists/Song.json", playlist("Song", [entry]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE, DisableFakeNetworkBridges="1")
    with UdpCapture(PORT, REMOTE) as cap:
        fppd.start()
        fppd.command("Start Playlist", "Song", "false", "false")
        time.sleep(secs + 3)
        syncs = [s for s in (parse_sync(t, p) for t, _, _, p in cap.snapshot()) if s]
    media = [s for s in syncs if s.file_type == "media"]
    actions = [s.action for s in media]
    assert media and all(s.filename == "Song.wav" for s in media), [(s.action, s.filename) for s in media][:5]
    assert actions[:2] == ["open", "start"], actions[:6]
    assert actions[-1] == "stop", actions[-3:]
    beats = [s for s in media if s.action == "sync"]
    assert len(beats) >= 3, f"only {len(beats)} media sync packets"
    for a, b in zip(beats, beats[1:]):
        assert b.seconds >= a.seconds, f"media position went back: {a.seconds} -> {b.seconds}"
    span = beats[-1].seconds - beats[0].seconds
    took = beats[-1].time - beats[0].time
    assert abs(span - took) < 1.0, f"position moved {span:.2f}s in {took:.2f}s"


def test_remote_counts_what_it_receives(fppd):
    """GET /fppd/multiSyncStats reports, per sending address, how many of
    each sync packet a remote received -- refused ones as errors -- and
    ?reset=1 zeroes them."""
    write_fseq(f"{fppd.media}/sequences/Show.fseq", unique_frames(100, CHANNELS), step_ms=STEP_MS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sent = [("open", "fseq", "Show.fseq")] * 2 + [("start", "fseq", "Show.fseq")] + \
        [("sync", "fseq", "Show.fseq")] * 5 + [("stop", "fseq", "Show.fseq")] + \
        [("open", "media", "Song.wav"), ("sync", "media", "Song.wav"), ("stop", "media", "Song.wav")] + \
        [("open", "fseq", "../Show.fseq")]
    fppd.start()
    for i, (action, kind, name) in enumerate(sent):
        sock.sendto(sync_packet(action, kind, i, i * 0.05, name), ("127.0.0.1", PORT))
        time.sleep(0.05)
    sock.close()
    time.sleep(0.5)

    def mine(stats):
        return [s for s in stats.get("systems", []) if s.get("sourceIP") == "127.0.0.1"]

    got = mine(fppd.get("/fppd/multiSyncStats"))
    assert len(got) == 1, fppd.get("/fppd/multiSyncStats")
    s = got[0]
    want = {"pktSyncSeqOpen": 2, "pktSyncSeqStart": 1, "pktSyncSeqSync": 5, "pktSyncSeqStop": 1,
            "pktSyncMedOpen": 1, "pktSyncMedSync": 1, "pktSyncMedStop": 1, "pktError": 1}
    assert {k: s[k] for k in want} == want, s
    after = mine(fppd.get("/fppd/multiSyncStats?reset=1"))
    assert after and all(after[0][k] == 0 for k in want), after


COUNT_SCRIPT = '#!/bin/sh\necho ran >> "$(dirname "$0")/count.log"\n'


def test_broadcast_command_runs_once_with_two_interfaces(fppd):
    """With MultiSync broadcast on and two interfaces up, a command sent to
    every host runs exactly once here: the sender runs it directly, and the
    broadcast copy that comes back on each interface is dropped as its own.

    Regression: af492df86. faa6774ed remembered one entry per sent packet,
    but a broadcast goes out once per interface and each copy loops back.
    The first echo used up the entry and the others were dispatched, so on
    a box with two interfaces (eth0 and wlan0) every all-hosts command ran
    twice locally. Two dummy interfaces stand in for them here (in Docker
    the container's eth0 makes a third).

    It fails before faa6774ed (MS-2) too, which checked no echo at all:
    every looped-back copy ran the command again, 4 runs here."""
    import os
    import subprocess

    def ip(*args):
        return subprocess.run(["ip", *args], capture_output=True, text=True)

    added = []
    try:
        for name, addr in (("fpptest0", "10.77.0.1/24"), ("fpptest1", "10.78.0.1/24")):
            r = ip("link", "add", name, "type", "dummy")
            if r.returncode:
                pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
            added.append(name)
            ip("addr", "add", addr, "dev", name)
            ip("link", "set", name, "up")
        scripts = os.path.join(fppd.media, "scripts")
        os.makedirs(scripts, exist_ok=True)
        path = os.path.join(scripts, "count.sh")
        with open(path, "w") as f:
            f.write(COUNT_SCRIPT)
        os.chmod(path, 0o755)
        log = os.path.join(scripts, "count.log")

        def runs():
            try:
                with open(log) as f:
                    return len(f.read().split())
            except FileNotFoundError:
                return 0

        fppd.settings(MultiSyncEnabled="1", MultiSyncBroadcast="1")
        fppd.start()
        local = {s["address"] for s in fppd.get("/fppd/multiSyncSystems")["systems"] if s.get("local")}
        assert {"10.77.0.1", "10.78.0.1"} <= local, f"fppd doesn't list both interfaces: {local}"
        for i in range(1, 4):
            fppd.post("/command", {"command": "Run Script", "multisyncCommand": True,
                                   "multisyncHosts": "", "args": ["count.sh", "", ""]})
            fppd.wait_for(lambda: runs() >= i, timeout=10, what=f"command {i} to run")
            time.sleep(1.5)  # every echo has come back and been handled
            assert runs() == i, f"{i} all-hosts commands ran {runs()} times here"
    finally:
        for name in added:
            ip("link", "del", name)


def test_a_send_buffer_that_never_drains_does_not_stall_the_show(fppd):
    """A master whose multicast and broadcast sockets can't send -- the
    interface stopped transmitting and their buffers are full -- keeps its
    own show running: frames keep reaching the controller on time and the
    sync packets are dropped. blocksend.so makes those sends fail with
    EAGAIN when they ask not to wait, and block for 1 s when they don't.

    Regression: 19d4c7899 (#3072). The multicast and broadcast sync sends
    blocked, on the channel output thread and holding the MultiSync socket
    lock: every sync packet stopped the show for as long as the send waited.
    """
    import contextlib

    import shims
    frames = unique_frames(400, CHANNELS)
    with contextlib.ExitStack() as stack:
        # In Docker eth0 is there as well; under run-local.sh this is the
        # only interface fppd sends multicast and broadcast out of.
        stack.enter_context(interface("10.77.0.1"))
        rx = stack.enter_context(DdpReceiver(CHANNELS))
        install(fppd, frames, step_ms=STEP_MS)
        fppd.settings(MultiSyncEnabled="1", MultiSyncMulticast="1", MultiSyncBroadcast="1")
        fppd.start(preload=[shims.build("blocksend.c")], extra_env={"BLOCKSEND_MS": "1000"})
        fppd.wait_for(lambda: "Starting main processing loop" in fppd.log(), timeout=60,
                      what="fppd to finish starting")
        fppd.command("Start Playlist", "Show", "false", "false")
        rx.wait_frames(1, timeout=10)
        time.sleep(6)
        times = [t for t, d in rx.snapshot() if any(d)]
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert len(times) >= 60, f"only {len(times)} frames in 6 s of a 20 fps show"
    assert max(gaps) < 0.25, f"the show stopped for {max(gaps):.2f} s"
