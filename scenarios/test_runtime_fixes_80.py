"""Fixes from the 7.0 and 8.0 releases that are reachable in fppd."""

import os
import time

from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output
from test_playlist_entries import playlist, status


def test_playing_sequence_reports_milliseconds_elapsed(fppd):
    """The current playlist entry of a playing sequence says how far in it is
    to the millisecond, in /api/player/current.

    Regression: dc635bb74. Entries gave whole seconds only, too coarse for a
    client following a sequence."""
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"),
               unique_frames(20 * 6, CHANNELS))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.write("playlists/P.json", playlist("P", main=[
        {"type": "sequence", "enabled": 1, "playOnce": 0, "sequenceName": "Song.fseq"}]))
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing")
    time.sleep(1.3)
    cur = fppd.get("/player/current")
    entry = cur["playlist"]["currentEntry"]
    assert entry.get("millisecondsElapsed", 0) >= 1000, entry
    assert entry["millisecondsElapsed"] < 5000, entry
    fppd.command("Stop Now")


def test_mqtt_start_topic_payload_is_the_start_position(fppd):
    """Publishing a number to set/playlist/<name>/start starts the playlist
    at that item, and the playlist stays what the file says it is (no repeat).

    Regression: 59fbbef0d. The payload went into the repeat argument, so
    "2" was read as repeat-on and the playlist began at its first item."""
    from test_mqtt_control import HOST, PORT, broker, publish
    from test_playlist_entries import pause
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    fppd.write("playlists/P.json", playlist("P", main=[pause(30), pause(31), pause(32)]))
    with broker():
        fppd.start()

        def started():
            publish("set/playlist/P/start", "2")
            return status(fppd).get("status_name") == "playing"
        fppd.wait_for(started, timeout=30, interval=1, what="fppd to start the playlist from MQTT")
        cur = status(fppd).get("current_playlist", {})
    # the lead-in's variable reset is entry 1; payload 2 is the second main item
    assert cur.get("index") == "3", cur


def test_ddp_packets_say_the_data_type_is_undefined(fppd):
    """DDP data packets carry data type 0 (undefined) in their header byte 2,
    as the spec has it for raw channel data, not "RGB".

    Regression: c41c08476. The type byte was 1, which receivers that honour
    it read as RGB pixel data."""
    import socket
    from fseq import solid_frames
    from show import install
    install(fppd, solid_frames(40, CHANNELS, 50))
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 4048))
    sock.settimeout(10)
    try:
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        pkt = sock.recv(2048)
    finally:
        sock.close()
    assert pkt[0] & 0xC0 == 0x40, pkt[:10].hex()  # DDP version 1
    assert pkt[2] == 0, pkt[:10].hex()
    fppd.command("Stop Now")


def test_cannot_ping_warning_names_the_output(fppd):
    """The warning for a controller that does not answer pings carries the
    output's description, so a person can tell which one it is.

    Regression: 28db9cd51 (#1284)."""
    out = ddp_output(CHANNELS, address="192.0.2.77")
    out["channelOutputs"][0]["universes"][0].update(monitor=1, description="Roof Tree")
    fppd.write("config/co-universes.json", out)
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    got = fppd.wait_for(lambda: [w for w in fppd.get("/fppd/warnings", timeout=5)
                                 if "Cannot Ping" in str(w)], timeout=120, interval=2,
                        what="the cannot-ping warning")
    assert "192.0.2.77" in str(got) and "Roof Tree" in str(got), got
