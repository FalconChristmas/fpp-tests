"""The status push WebSocket, /fppdws on fppd's API port (StatusWebSocket.cpp).

fppd sends every client {"type":"snapshot","data":{"status":{...}}}, where
status is what GET /fppd/status answers: once as soon as the client
connects, then from a 1 s timer whenever the payload changed (its clock
fields change every second, so a plain client hears about once a second), and
straight away when a warning appears. A client that connects with ?quiet=1
hears only when something other than the clock changed, plus a keepalive
every 30 s. Anything a client sends is ignored; drogon answers pings itself.

The scenarios here use wsclient.py, a hand-rolled RFC 6455 client, and wait
for the content they expect with deadlines rather than for set times."""

import json
import os
import random
import socket
import threading
import time
import urllib.error

import pytest

from fseq import unique_frames
from show import install
from wsclient import BINARY, CLOSE, CONT, PONG, TEXT, WebSocket

# Status keys that change with nothing having happened: the clock and uptime
# fields (StatusWebSocket.cpp's kTickingKeys).
TICKING = {"time", "timeStr", "timeStrFull", "dateStr", "uptime", "uptimeStr",
           "uptimeTotalSeconds", "uptimeSeconds", "uptimeMinutes", "uptimeHours",
           "uptimeDays", "systemUptimeTotalSeconds", "sensors"}
# ...and those that move on their own while a sequence plays.
POSITION = {"seconds_played", "seconds_elapsed", "seconds_remaining", "time_elapsed",
            "time_remaining", "milliseconds_elapsed"}


def show(fppd, seconds=120):
    """A playlist "Show" that plays Show.fseq for `seconds` (20 fps)."""
    install(fppd, unique_frames(seconds * 20, 30))


def snapshot(ws, timeout=10):
    """The next status snapshot from `ws`, with the envelope checked."""
    op, payload = ws.message(timeout=timeout)
    assert op == TEXT, f"expected a text frame, got opcode {op}: {payload[:200]!r}"
    msg = json.loads(payload)
    assert msg.get("type") == "snapshot" and set(msg.get("data", {})) == {"status"}, \
        f"not a status snapshot: {payload[:300]!r}"
    return msg["data"]["status"]


def wait_snapshot(ws, pred, timeout=15, what="a matching status"):
    """Read snapshots until one satisfies `pred`; return it."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = snapshot(ws, timeout=max(deadline - time.monotonic(), 0.01))
        except socket.timeout:
            break
        if pred(last):
            return last
    raise AssertionError(f"no {what} pushed within {timeout}s (last: "
                         f"{ {k: last.get(k) for k in ('status_name', 'current_playlist', 'warnings')} if last else None})")


def without(status, keys):
    return {k: v for k, v in status.items() if k not in keys}


def playing_show(s):
    return s["status_name"] == "playing" and s["current_playlist"]["playlist"] == "Show"


def idle(s):
    return s["status_name"] == "idle" and s["current_playlist"]["playlist"] == ""


def assert_same_status(pushed, before, after, ignore):
    """`pushed` is GET /fppd/status's answer from just before or just after
    it was sent, field for field apart from `ignore` (a warning, such as the
    one for a missing avahi-daemon, can appear at any moment)."""
    got = without(pushed, ignore)
    if got != without(after, ignore):
        assert got == without(before, ignore)


def open_fds(fppd):
    return len(os.listdir(f"/proc/{fppd.proc.pid}/fd"))


def test_a_new_client_gets_the_current_status_at_once(fppd):
    """A client gets a full status snapshot as soon as it connects, and it is
    the same status GET /fppd/status gives: field for field apart from the
    clock (idle), and with the playing playlist and sequence named while one
    plays.

    The connect snapshot is told apart from a timer push with a quiet client:
    once an earlier quiet client has been sent the current state, the timer
    has nothing new for quiet clients for 30 s, so a second quiet client that
    hears anything within 10 s heard the snapshot its connection sent (unless
    a warning happened to appear just then, which can only make this pass)."""
    show(fppd)
    fppd.start()

    first = WebSocket("/fppdws?quiet=1")
    snapshot(first)
    # Let a tick or two pass so the quiet clients' view is current.
    end = time.monotonic() + 2.5
    while time.monotonic() < end:
        try:
            snapshot(first, timeout=end - time.monotonic())
        except socket.timeout:
            break

    before = fppd.get("/fppd/status")
    second = WebSocket("/fppdws?quiet=1")
    pushed = snapshot(second, timeout=10)
    after = fppd.get("/fppd/status")
    assert pushed["status_name"] == "idle"
    assert_same_status(pushed, before, after, TICKING)

    fppd.command("Start Playlist", "Show", "true", "false")
    fppd.wait_for(lambda: playing_show(fppd.get("/fppd/status")), what="the playlist to play")
    before = fppd.get("/fppd/status")
    plain = WebSocket("/fppdws")
    pushed = snapshot(plain)
    after = fppd.get("/fppd/status")
    assert playing_show(pushed), pushed
    assert pushed["current_sequence"] == "Show.fseq"
    assert pushed["current_playlist"]["type"] == "sequence"
    assert_same_status(pushed, before, after, TICKING | POSITION)
    for ws in (first, second, plain):
        ws.close()


def test_playlist_start_and_stop_are_pushed(fppd):
    """A connected client is told when a playlist starts and when it stops,
    without polling: a snapshot naming the playlist and its sequence, then
    one that is idle again. While it plays, a snapshot arrives about once a
    second with the position moving on: at least 3 and at most 10 in 5 s,
    which rules out both a stalled feed and a push storm.

    Covers 12e2ffb37, which added the push."""
    show(fppd)
    fppd.start()
    ws = WebSocket("/fppdws")
    assert idle(snapshot(ws))

    fppd.command("Start Playlist", "Show", "true", "false")
    playing = wait_snapshot(ws, playing_show, what="playing Show")
    assert playing["current_sequence"] == "Show.fseq"

    end = time.monotonic() + 5
    during = []
    while time.monotonic() < end:
        try:
            during.append(snapshot(ws, timeout=end - time.monotonic()))
        except socket.timeout:
            break
    assert 3 <= len(during) <= 10, f"{len(during)} snapshots in 5 s while playing"
    assert all(playing_show(s) for s in during)
    played = [int(s["seconds_played"]) for s in during]
    assert played == sorted(played) and played[-1] > played[0], played

    fppd.command("Stop Now")
    stopped = wait_snapshot(ws, idle, what="idle after Stop Now")
    assert stopped["current_sequence"] == ""
    ws.close()


def test_quiet_clients_hear_changes_and_a_keepalive_only(fppd):
    """A ?quiet=1 client on an idle fppd (one that has settled: see below)
    hears nothing while a plain client hears the clock tick, then gets a keepalive about 30 s after its last
    snapshot (with the clock moved on and nothing else different). A new
    warning (an unknown command) reaches both clients, and so does a playlist
    starting.

    Regression: 6160f962f, which added ?quiet=1. On its parent every client
    gets the clock tick, so the quiet one hears it too."""
    show(fppd)
    fppd.start()
    # Without an avahi-daemon (as in Docker), fppd adds a warning about it
    # some 30 s after starting; that is a change quiet clients hear, so the
    # silence and keepalive checks start after it (or, where avahi works and
    # it never comes, once it would long since have come).
    def settled(st):
        return (any("mDNS/Avahi" in w for w in st.get("warnings", []))
                or st["uptimeTotalSeconds"] >= 75)
    fppd.wait_for(lambda: settled(fppd.get("/fppd/status")), timeout=120, interval=1,
                  what="fppd's start-up warnings to settle")
    plain = WebSocket("/fppdws")
    quiet = WebSocket("/fppdws?quiet=1")
    last = snapshot(quiet)
    last_at = time.monotonic()
    snapshot(plain)

    # The quiet client may get one more snapshot of the same state (its view
    # starts empty at the first tick); let it settle.
    end = time.monotonic() + 2.5
    while time.monotonic() < end:
        try:
            s = snapshot(quiet, timeout=end - time.monotonic())
        except socket.timeout:
            break
        assert without(s, TICKING) == without(last, TICKING)
        last, last_at = s, time.monotonic()

    times = set()
    while len(times) < 4:
        times.add(snapshot(plain)["time"])
    with pytest.raises(socket.timeout):
        snapshot(quiet, timeout=0.5)

    keepalive = snapshot(quiet, timeout=45)
    gap = time.monotonic() - last_at
    assert 28 <= gap <= 40, f"keepalive came {gap:.1f} s after the last snapshot"
    assert without(keepalive, TICKING) == without(last, TICKING)
    assert keepalive["time"] != last["time"]

    with pytest.raises(urllib.error.HTTPError):  # refused, and a warning added
        fppd.command("No Such Command For The Status Socket")
    warned = lambda s: any("No Such Command For The Status Socket" in w
                           for w in s.get("warnings", []))
    wait_snapshot(quiet, warned, what="the new warning (quiet client)")
    wait_snapshot(plain, warned, timeout=60, what="the new warning (plain client)")

    fppd.command("Start Playlist", "Show", "true", "false")
    wait_snapshot(quiet, playing_show, what="playing Show (quiet client)")
    plain.close()
    quiet.close()


def test_what_a_client_sends_is_ignored(fppd):
    """The socket is read-only: text (including something shaped like a
    command), binary and fragmented messages from a client change nothing and
    don't cost it its connection, and a ping is answered with a pong carrying
    the same payload. The client goes on getting status snapshots after."""
    show(fppd)
    fppd.start()
    ws = WebSocket("/fppdws")
    snapshot(ws)

    ws.send("pong")
    ws.send(json.dumps({"command": "Start Playlist", "args": ["Show", "true", "false"]}))
    ws.send(b"\x00\x01\x02\xff" * 300, BINARY)
    ws.send("frag", TEXT, fin=False)
    ws.send("mented", CONT)
    ws.send("x" * 70000)  # a 64-bit length
    ws.send(b"abc", 0x9)
    deadline = time.monotonic() + 10
    while True:
        op, payload = ws.message(timeout=max(deadline - time.monotonic(), 0.01))
        if op == PONG:
            break
        assert op == TEXT, f"unexpected opcode {op}"
    assert payload == b"abc"

    snapshot(ws)
    snapshot(ws)
    # Nothing it sent started the playlist.
    assert idle(fppd.get("/fppd/status"))
    ws.close()


def test_clients_that_go_away_are_let_go(fppd):
    """Clients leaving in every way, many of them while snapshots are being
    pushed -- a close frame, a plain FIN, a half-close, a TCP reset right
    after connecting or before even reading the upgrade, and resets after
    staying for a few pushes -- while a show plays. Through all of it a
    client that stays keeps getting snapshots (never 5 s without one) with
    the position moving on, a client that sent a close frame has its stream
    ended by fppd, fppd's open file descriptors go back to where they were
    (so every closed connection was let go, not kept in the push list), and
    a new client still gets a correct snapshot."""
    show(fppd)
    fppd.start()
    fppd.command("Start Playlist", "Show", "true", "false")
    watcher = WebSocket("/fppdws")
    wait_snapshot(watcher, playing_show, what="playing Show")

    seen = []
    stop = threading.Event()

    def watch():
        while not stop.is_set():
            try:
                seen.append((time.monotonic(), snapshot(watcher, timeout=10)))
            except Exception as e:  # recorded; the asserts below say what went wrong
                seen.append((time.monotonic(), e))
                return

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    time.sleep(1.5)
    baseline = open_fds(fppd)

    rnd = random.Random(6455)
    unanswered_close = []
    kinds = ["close-frame", "fin", "half-close", "reset", "reset-before-upgrade", "stay-then-reset"]
    for _ in range(8):
        clients = []
        for i in range(18):
            kind = kinds[i % len(kinds)]
            ws = WebSocket("/fppdws", handshake=kind != "reset-before-upgrade")
            clients.append((kind, ws))
        rnd.shuffle(clients)
        for kind, ws in clients:
            time.sleep(rnd.random() * 0.12)
            if kind == "close-frame":
                ws.send_close()
                try:
                    while True:
                        op, _ = ws.message(timeout=10)
                        if op == CLOSE:
                            break
                except ConnectionError:
                    pass  # fppd ended the stream: the close was honoured
                except socket.timeout:
                    unanswered_close.append(ws)
                ws.close()
            elif kind == "fin":
                ws.close()
            elif kind == "half-close":
                ws.s.shutdown(socket.SHUT_WR)
                ws.close()
            else:
                ws.abort()

    stop.set()
    t.join(15)
    assert not unanswered_close, f"{len(unanswered_close)} close frames left the stream open"
    errors = [s for _, s in seen if isinstance(s, Exception)]
    assert not errors, f"the staying client lost its feed: {errors[0]!r}"
    stamps = [at for at, _ in seen]
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    assert len(seen) >= 5 and max(gaps) < 5, f"{len(seen)} snapshots, longest gap {max(gaps, default=0):.1f} s"
    assert all(playing_show(s) for _, s in seen)
    played = [int(s["seconds_played"]) for _, s in seen]
    assert played == sorted(played) and played[-1] > played[0], played

    fppd.wait_for(lambda: open_fds(fppd) <= baseline + 8, timeout=15,
                  what=f"fppd's open files to fall back to about {baseline}")
    late = WebSocket("/fppdws")
    assert playing_show(snapshot(late))
    late.close()
    watcher.close()


def test_many_clients_at_once(fppd):
    """Forty clients connecting at the same moment each get an idle snapshot,
    each hear the playlist start, and are still connected when fppd is
    stopped -- along with one that never reads -- which it does cleanly (exit
    0, no sanitizer report). Under TSan this has every drogon IO thread
    connecting, sending and dropping clients against the push timer."""
    show(fppd)
    fppd.start()
    n = 40
    ready = threading.Barrier(n + 1)
    connected = threading.Barrier(n + 1)
    started = threading.Event()
    results = [None] * n
    clients = [None] * n

    def client(i):
        try:
            ready.wait(timeout=30)
            ws = clients[i] = WebSocket("/fppdws", timeout=30)
            first = snapshot(ws, timeout=30)
            connected.wait(timeout=60)
            assert idle(first), first["status_name"]
            started.wait(timeout=60)
            wait_snapshot(ws, playing_show, timeout=30, what="playing Show")
            results[i] = "ok"
        except Exception as e:  # reported below with the client's number
            results[i] = repr(e)

    threads = [threading.Thread(target=client, args=(i,), daemon=True) for i in range(n)]
    for th in threads:
        th.start()
    ready.wait(timeout=30)
    connected.wait(timeout=60)
    stalled = WebSocket("/fppdws", rcvbuf=4096, handshake=False)
    fppd.command("Start Playlist", "Show", "true", "false")
    started.set()
    for th in threads:
        th.join(90)
    bad = [(i, r) for i, r in enumerate(results) if r != "ok"]
    assert not bad, f"{len(bad)} clients failed, e.g. {bad[:3]}"

    time.sleep(3)  # a few pushes to everyone, the stalled client included
    rc = fppd.stop(timeout=30)
    fppd.exit_expected = True
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
    assert rc == 0, f"fppd exited with {rc} on SIGTERM with clients connected\n{fppd.tail()}"
    for ws in clients:
        ws.close()
    stalled.close()
