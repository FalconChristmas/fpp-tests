"""MultiSync control packets on UDP 32320: hostile ones, FPP Command
packets, a remote's handling of sync it didn't expect, and a master
sending to a remote it can't reach."""

import socket
import struct
import time

import pytest

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from multisync import (PORT, control_packet, fpp_command_packet, ping_packet,
                       sync_packet)
from show import CHANNELS, ddp_output, install, status

STEP_MS = 50


class Sender:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 20)

    def __call__(self, packet):
        self.sock.sendto(packet, ("127.0.0.1", PORT))

    def close(self):
        self.sock.close()


def variable(fppd, name):
    return ((fppd.get("/variables", timeout=5) or {}).get(name) or {}).get("value")


def hostile_packets():
    """Every packet type, lying about its length, missing terminators,
    truncated, oversized, and with fields of nonsense."""
    out = []
    ff = b"\xff" * 400
    for ptype in range(0, 9):
        out += [
            control_packet(ptype, b""),
            control_packet(ptype, b"", claimed_len=0xFFFF),
            control_packet(ptype, b"x", claimed_len=0),
            control_packet(ptype, ff),
            control_packet(ptype, ff, claimed_len=0xFFFF),
            control_packet(ptype, ff, claimed_len=3),
            control_packet(ptype, b"A" * 1400),
            control_packet(ptype, b"\0" * 60000),
        ]
    out += [b"", b"F", b"FPPD", b"FPPD\x01", b"FPPD\x01\x05", b"XXXX" + b"\0" * 40]
    # sync: unknown action and type, no terminator, odd seconds
    for action in (0, 1, 2, 3, 9):
        for ftype in (0, 1, 7):
            for secs in (float("nan"), float("inf"), -1e30, 1e30):
                extra = struct.pack("<BBIf", action, ftype, 0xFFFFFFFF, secs) + b"S" * 300
                out.append(control_packet(0x01, extra))
    out.append(sync_packet("start", "fseq", 0, 0, "../../../../etc/passwd"))
    out.append(sync_packet("open", "media", 0, 0, "/etc/passwd"))
    out.append(sync_packet("start", "fseq", 0, 0, "A" * 5000))
    # ping: every version, fields with no terminators, lengths off by one
    for v in (1, 2, 3, 4, 5, 200):
        base = ping_packet("10.9.8.7", b"H" * 80, version=min(max(v, 1), 4),
                           ver=b"V" * 60, model=b"M" * 60, ranges=b"9" * 200, uuid=b"U" * 90)
        extra = bytes([v]) + base[8:]
        for n in (168, 169, 170, 213, 214, 215, 293, 294, 295, 358, 359, 360, 1400):
            body = (extra + b"Z" * 1500)[:n]
            out.append(control_packet(0x04, body))
            out.append(control_packet(0x04, extra[:40], claimed_len=n))
    out.append(ping_packet("0.0.0.0", "nobody", discover=True))
    # FPP Command: counts that lie, strings that run off the end
    out += [
        fpp_command_packet("Set Variable", ["fuzz", "Value", "1"], nargs=255),
        fpp_command_packet("Set Variable", ["fuzz", "Value", "1"], nargs=200),
        fpp_command_packet("Set Variable", ["fuzz", "Value", "1"])[:-1],
        control_packet(0x06, b"\x03" + b"h" * 500),
        control_packet(0x06, b"\x03\0" + b"c" * 500),
        fpp_command_packet("No Such Command", ["x"] * 250),
        fpp_command_packet("Set Variable", ["fuzz", "Value", "z" * 60000]),
    ]
    # plugin and legacy command: no terminator
    out += [control_packet(0x05, b"p" * 500), control_packet(0x00, b"c" * 500)]
    return out


@pytest.mark.parametrize("mode", ["player", "remote"])
def test_hostile_control_packets_are_survived(fppd, mode):
    """Malformed control packets of every type are counted as errors and
    dropped: fppd neither crashes nor reads past a packet, and it still
    obeys a good packet afterwards.

    Regressions: 4169a5dcb (control-packet parsing trusted the lengths the
    sender wrote; on its parent a burst of short packets misaligned the
    skip-stale-sync indexes with the receive buffers, a heap-use-after-free)
    and bcc9fda5f (ping fields strcpy()'d into a stack buffer: with that
    copy put back, a stack-buffer-overflow).
    """
    write_fseq(f"{fppd.media}/sequences/Show.fseq", unique_frames(400, CHANNELS), step_ms=STEP_MS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode=mode)
    fppd.start()
    send = Sender()
    packets = hostile_packets()
    for rnd in range(3):
        for i, p in enumerate(packets):
            try:
                send(p)
            except OSError:
                pass  # too big for UDP
            if i % 50 == 0:
                time.sleep(0.01)
        time.sleep(0.2)
        fppd.get("/fppd/status", timeout=10)
    assert variable(fppd, "fuzz") is None, "a malformed FPP Command packet ran its command"
    send(fpp_command_packet("Set Variable", ["after", "Value", "ok"]))
    fppd.wait_for(lambda: variable(fppd, "after") == "ok", timeout=5,
                  what="a good FPP Command packet after the bad ones")
    if mode == "remote":
        send(sync_packet("open", "fseq", 0, 0, "Show.fseq"))
        send(sync_packet("start", "fseq", 0, 0, "Show.fseq"))
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=5,
                      what="a good sync packet after the bad ones")
    send.close()


def test_fpp_command_packet_runs_for_this_host_only(fppd):
    """An FPP Command packet runs its command when it names no host, this
    host's name or one of a list of names including it -- and not when it
    names another host."""
    fppd.settings(HostName="fpp-under-test")
    fppd.start()
    send = Sender()
    send(fpp_command_packet("Set Variable", ["any", "Value", "1"]))
    send(fpp_command_packet("Set Variable", ["named", "Value", "2"], host="fpp-under-test"))
    send(fpp_command_packet("Set Variable", ["listed", "Value", "3"], host="other,fpp-under-test"))
    send(fpp_command_packet("Set Variable", ["elsewhere", "Value", "4"], host="other"))
    fppd.wait_for(lambda: variable(fppd, "listed") == "3", timeout=5, what="the commands to run")
    assert variable(fppd, "any") == "1"
    assert variable(fppd, "named") == "2"
    time.sleep(0.5)
    assert variable(fppd, "elsewhere") is None, "a command for another host ran here"
    send.close()


def test_fpp_command_packet_with_many_arguments(fppd):
    """An argument count above 127 is read as the count it is, not as a
    negative number that drops the arguments (4169a5dcb). Only a build
    where char is signed (x86) could fail this before the fix; on ARM it
    is coverage."""
    fppd.start()
    send = Sender()
    send(fpp_command_packet("Set Variable", ["many", "Value", "yes"] + ["pad"] * 130))
    fppd.wait_for(lambda: variable(fppd, "many") == "yes", timeout=5,
                  what="the command with 133 arguments to run")
    send.close()


def test_player_ignores_sync_packets(fppd):
    """Sync packets drive a remote; a player that receives them plays
    nothing."""
    write_fseq(f"{fppd.media}/sequences/Show.fseq", unique_frames(200, CHANNELS), step_ms=STEP_MS)
    fppd.start()
    send = Sender()
    for action in ("open", "start", "sync"):
        send(sync_packet(action, "fseq", 20, 1.0, "Show.fseq"))
    time.sleep(1)
    assert status(fppd).get("status_name") == "idle", status(fppd)
    send.close()


def test_remote_starts_on_sync_after_a_lost_start(fppd):
    """A remote that got the open but missed the start (UDP drops it, or it
    came up mid-show) starts playing from the sync packets that follow, at
    the master's frame.

    Regression: 8e64e1c91. A file that was open but not started counted as
    running, so sync packets never started it; with that check put back
    the remote stays idle."""
    frames = unique_frames(600, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(f"{fppd.media}/sequences/Show.fseq", frames, step_ms=STEP_MS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    send = Sender()
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        send(sync_packet("open", "fseq", 0, 0, "Show.fseq"))
        time.sleep(0.5)
        began = time.monotonic() - 5.0  # the master is 5 s in
        for _ in range(6):
            frame = round((time.monotonic() - began) * 1000 / STEP_MS)
            send(sync_packet("sync", "fseq", frame, frame * STEP_MS / 1000, "Show.fseq"))
            time.sleep(0.5)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=5,
                      what="the remote to start from sync packets")
        now = round((time.monotonic() - began) * 1000 / STEP_MS)
        shown = [lookup.get(d[:CHANNELS]) for _, d in rx.snapshot(since=time.monotonic() - 0.3)]
        shown = [i for i in shown if i is not None]
        assert shown and abs(shown[-1] - now) <= 6, \
            f"remote showing frame {shown[-1] if shown else None}, master at {now}"
    send.close()


@pytest.mark.parametrize("remotes", ["127.0.0.2,10.66.66.66", "10.66.66.66,127.0.0.2"],
                         ids=["unreachable second", "unreachable first"])
def test_unreachable_remote_does_not_stall_output(fppd, remotes):
    """A master whose unicast remotes include one it can't reach keeps
    sending its own frames at full rate, and keeps syncing the remotes it
    can reach.

    Regression: d80973d93, which reworked a send loop that gave up on the
    whole batch -- or, on a LAN where a vanished remote answers with
    EAGAIN, never gave up at all and froze the output thread. On its
    parent, in either order, the reachable remote got no sync packets. (A
    network namespace fails an unroutable send at once, so the freeze
    itself doesn't reproduce here.)
    """
    from capture import UdpCapture
    from multisync import parse_sync
    frames = unique_frames(400, CHANNELS)
    with UdpCapture(PORT, "127.0.0.2") as cap, DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        # 10.x has no route in this network namespace: every send to it fails
        fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=remotes)
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(lambda: rx.last() is not None, timeout=10, what="output to start")
        since = time.monotonic()
        time.sleep(4)
        got = len(rx.snapshot(since=since))
        syncs = [s for s in (parse_sync(t, p) for t, _, _, p in cap.snapshot()) if s and s.time >= since]
    expect = 4000 / STEP_MS
    assert got >= expect * 0.8, f"{got} frames in 4 s, expected about {expect:.0f}"
    assert len(syncs) >= 4, f"the reachable remote got {len(syncs)} sync packets in 4 s"


def test_remote_media_starts_where_the_master_is(fppd, audio):
    """A media start packet carries how far into the file the master is,
    and the remote starts its audio there rather than from the top: a 6 s
    tone started 3 s in plays for 3 s.

    Regression: 83b0b30e4. The remote ignored the seconds in the start
    packet and always played the whole file.
    """
    import os
    from audio import write_tone_wav
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 6, amplitude=0.5)
    fppd.settings(fppMode="remote")
    fppd.start()
    send = Sender()
    rec = audio.record()
    send(sync_packet("open", "media", 0, 0, "Tone.wav"))
    time.sleep(0.5)
    send(sync_packet("start", "media", 0, 3.0, "Tone.wav"))
    time.sleep(7.5)
    samples = rec.stop()
    send.close()
    from test_media import sounding
    first, last = sounding(samples)
    assert first is not None, "the remote played nothing"
    heard = last - first
    assert 2.5 <= heard <= 3.5, f"heard {heard:.2f} s of a 6 s file started 3 s in"
