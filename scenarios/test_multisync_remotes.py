"""MultiSync's view of other systems, from what reaches it and what it sends
them: the type names it lists, the identity it reports for itself, the
"all known remotes" unicast mode, sync stats and the background HTTP pings.

Pings are sent over loopback and name the address they describe, as in
test_multisync_systems.py; a dummy interface gives fppd addresses beyond
loopback where a test needs packets to leave for another box.
"""

import socket
import time

import shims
from capture import UdpCapture
from fseq import unique_frames, write_fseq
from multisync import PORT, parse_sync, ping_packet, sync_packet
from show import CHANNELS, ddp_output, install
from test_multisync_systems import interface, send, wait_listed

STEP_MS = 50


def test_a_yps_vivid_8_is_listed_by_its_name(fppd):
    """A ping from a YPS VIVID 8 (system type 0xA6) lists the controller as
    "YPS VIVID 8".

    Regression: 47e8ece33. It was listed as "YPS VIDID 8". (Its parent
    doesn't build: the constant had been renamed in MultiSync.h only.)
    """
    fppd.start()
    send(ping_packet("10.20.31.66", "vivid", version=3, type_id=0xA6))
    s = wait_listed(fppd, "10.20.31.66")
    assert s["typeId"] == 0xA6, s
    assert s["type"] == "YPS VIVID 8", s


def test_a_new_system_uuid_is_reported_without_a_restart(fppd):
    """The status API reports the SystemUUID setting as it is now: one set in
    the settings file after fppd has answered a status request shows in the
    next one, as it does in the setting itself.

    Regression: 9d5633676. The status kept, for as long as fppd ran, the
    UUID it read on the first request, so an early request (before the UUID
    was set) left the status with a different UUID from the rest of the API.
    """
    fppd.settings(LogLevel_Settings="debug")
    fppd.start()
    before = fppd.get("/fppd/status")["uuid"]
    new = "M1-fpp-tests-0123456789ab"
    assert before != new, before
    time.sleep(1.1)  # a change the file monitor sees as a new write
    fppd.settings(SystemUUID=new)
    fppd.wait_for(lambda: f"Setting SystemUUID:  from {before} to {new}" in fppd.log(),
                  timeout=10, interval=0.25, what="fppd to take in the new SystemUUID")
    now = fppd.get("/fppd/status")["uuid"]
    assert now == new, f"/fppd/status reports UUID {now!r}; SystemUUID is {new!r}"


def test_sync_stats_reset_while_a_packet_is_being_counted(fppd):
    """Resetting the sync stats (GET /fppd/multiSyncStats?reset=1) while the
    main loop is still handling a sender's packet zeroes that sender's
    counters and keeps it listed; the packet is counted once it has been
    handled. Here the remote's open of the sequence is made slow (2 s, with
    slowfileopen.so) and the reset lands inside it.

    Regression: bf4fcf8f9. The reset deleted every sender's stats and
    cleared the list, though the receive path keeps a pointer to the
    sender's entry until the packet is handled: the count after the open
    went into freed memory (ASan: heap-use-after-free in
    ProcessSyncPacket), and every sender dropped off the stats until it
    sent again.
    """
    write_fseq(f"{fppd.media}/sequences/Show.fseq", unique_frames(100, CHANNELS), step_ms=STEP_MS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote", LogLevel_Sequence="debug")
    fppd.start(preload=[shims.build("slowfileopen.c")],
               extra_env={"SLOWFILEOPEN_SUFFIX": "/Show.fseq", "SLOWFILEOPEN_MS": "2000"})

    def mine():
        return [s for s in fppd.get("/fppd/multiSyncStats").get("systems", [])
                if s.get("sourceIP") == "127.0.0.1"]

    send(ping_packet("10.20.31.70", "stats-master"))
    fppd.wait_for(lambda: mine() and mine()[0]["pktPing"] == 1, timeout=5,
                  what="the master's ping to be counted")
    send(sync_packet("open", "fseq", 0, 0, "Show.fseq"))
    fppd.wait_for(lambda: "OpenSequenceFile(Show.fseq" in fppd.log(), timeout=5, interval=0.05,
                  what="the remote to start opening the sequence")
    held = time.monotonic()
    after = [s for s in fppd.get("/fppd/multiSyncStats?reset=1").get("systems", [])
             if s.get("sourceIP") == "127.0.0.1"]
    assert time.monotonic() - held < 1.5, "precondition: the reset landed inside the slow open"
    # Past the end of the open, which is when the reset's victim is counted.
    fppd.wait_for(lambda: time.monotonic() - held > 2.5 and fppd.get("/fppd/status"), timeout=10,
                  interval=0.2, what="the slow open to finish")
    assert after and after[0]["pktPing"] == 0, f"right after the reset: {after}"
    now = mine()
    assert now and now[0]["pktSyncSeqOpen"] == 1 and now[0]["pktPing"] == 0, now


def test_all_known_remotes_get_the_sync_by_unicast(fppd):
    """With "send MultiSync to all known remotes via unicast"
    (MultiSyncUnicast) the only send method, a master playing a sequence
    sends its sync packets to each FPP remote it has heard from that is in
    remote mode, at that remote's address: here one found by its ping while
    fppd runs. A player and a non-FPP controller (an ESPixelStick, also
    claiming remote mode) heard from the same way get none, and nothing is
    multicast. The packets are seen leaving on the interface the remotes are
    on.

    Regression: 588adaf40, which added the setting. Before it the setting
    did nothing: with no remote list, sync was multicast to 239.70.80.80
    and no remote was sent a packet of its own.
    """
    frames = unique_frames(1200, CHANNELS)
    install(fppd, frames, step_ms=STEP_MS)
    fppd.settings(MultiSyncEnabled="1", MultiSyncUnicast="1")
    remote, player, esps = "10.77.0.9", "10.77.0.10", "10.77.0.11"
    with interface("10.77.0.1"):
        fppd.start()
        with UdpCapture(PORT, iface="fpptest0") as cap:
            send(ping_packet(remote, "unicast-remote", mode=0x08))
            send(ping_packet(player, "unicast-player", mode=0x02))
            send(ping_packet(esps, "unicast-esps", type_id=0xC3, mode=0x08))
            for a in (remote, player, esps):
                wait_listed(fppd, a)
            fppd.command("Start Playlist", "Show", "false", "false")
            time.sleep(3)
            packets = cap.snapshot()
    syncs = {}
    for t, _, dst, p in packets:
        if parse_sync(t, p):
            syncs[dst] = syncs.get(dst, 0) + 1
    assert syncs.get(remote, 0) >= 5, f"sync packets by destination: {syncs}"
    assert set(syncs) == {remote}, f"sync packets by destination: {syncs}"


def test_sync_is_handled_while_quiet_remotes_are_probed(fppd):
    """A remote keeps handling its master's sync packets while fppd probes,
    over HTTP, the controllers it has not heard from in 80 minutes: six
    WLEDs found by HTTP discovery of this box's outputs stop answering
    (held_device_server.py holds every request), the clock moves on 81
    minutes, and the probes of all six go out -- while the sync packets,
    sent 20 times a second, are still counted as they arrive, never more
    than a second apart.

    Regression: dd4d070ca. PeriodicPing() probed them one after another on
    the main loop, the thread that reads the MultiSync socket, each until
    its 1 s timeout: the remote handled no sync packet for six seconds, and
    its show froze and then jumped.
    """
    import json
    import os
    import sys
    import tempfile
    import threading
    from fake_devices import device_network, page, wait_ready
    devices = [f"10.88.0.{n}" for n in range(2, 8)]
    pages = {a: {"/": page("<html><head><title>WLED UI</title></head></html>"),
                 "/json/info": page({"ver": "0.14.4", "name": f"wled-{i}", "arch": "esp32"})}
             for i, a in enumerate(devices)}
    flag = os.path.join(fppd.media, "tmp-hold-requests")
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510 * len(devices),
        "universes": [{"active": 1, "description": "", "id": i + 1, "startChannel": 510 * i + 1,
                       "size": 510, "type": 1, "address": a, "priority": 0, "monitor": 0,
                       "deDuplicate": 0, "channelCount": 510} for i, a in enumerate(devices)]}]})
    write_fseq(f"{fppd.media}/sequences/Show.fseq", unique_frames(2000, CHANNELS), step_ms=STEP_MS)
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    server = os.path.join(os.path.dirname(os.path.abspath(__file__)), "held_device_server.py")
    with device_network(devices) as run, tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        json.dump(pages, f)
        f.flush()
        proc = run(sys.executable, "-I", server, f.name, flag)
        wait_ready(proc, devices[0])
        held = []
        threading.Thread(target=lambda: held.extend(iter(proc.stdout.readline, "")),
                         daemon=True).start()
        fppd.start(fake_time="2026-11-02 12:00:00")

        def wleds():
            return {s["address"] for s in fppd.get("/fppd/multiSyncSystems")["systems"]
                    if s.get("type") == "WLED"}
        fppd.wait_for(lambda: wleds() >= set(devices), timeout=40, interval=0.5,
                      what="HTTP discovery to list the six WLEDs")
        open(flag, "w").close()

        done = threading.Event()

        def master():
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            frame = 0
            while not done.is_set():
                s.sendto(sync_packet("sync", "fseq", frame, frame * STEP_MS / 1000, "Show.fseq"),
                         ("127.0.0.1", PORT))
                frame += 1
                done.wait(0.05)
            s.close()
        sender = threading.Thread(target=master, daemon=True)
        sender.start()
        try:
            def synced():
                got = [s for s in fppd.get("/fppd/multiSyncStats").get("systems", [])
                       if s.get("sourceIP") == "127.0.0.1"]
                return got[0]["pktSyncSeqSync"] if got else 0
            fppd.wait_for(lambda: synced() > 10, timeout=10, what="the sync packets to be counted")
            fppd.set_clock("2026-11-02 13:21:00")
            fppd.wait_for(lambda: [h for h in held if h.startswith("held ")], timeout=90, interval=0.1,
                          what="fppd to probe the quiet WLEDs")
            samples = []
            end = time.monotonic() + 7
            while time.monotonic() < end:
                samples.append((time.monotonic(), synced()))
                time.sleep(0.1)
        finally:
            done.set()
            sender.join()
        probed = {h.split()[1] for h in held if h.startswith("held ")}
    assert len(probed) >= 2, f"precondition: the quiet WLEDs were probed: {held}"
    stall, last_t, last_n = 0.0, samples[0][0], samples[0][1]
    for t, n in samples[1:]:
        if n != last_n:
            last_t, last_n = t, n
        stall = max(stall, t - last_t)
    assert stall < 1.0, (f"no sync packet was handled for {stall:.1f} s while the quiet "
                         f"WLEDs ({sorted(probed)}) were probed")
