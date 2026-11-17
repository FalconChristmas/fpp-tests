"""/fppd/status caches its slow parts (sensors, identity, clock strings) but
builds the playback position fresh on every call, for the callers that poll
it several times a second to follow a show."""

import os
import time

from fseq import solid_frames, write_fseq
from show import ddp_output, playlist, sequence_entry


def test_status_polled_faster_than_once_a_second_tracks_the_position(fppd):
    """Polled every 100 ms while a sequence plays, /fppd/status reports a
    new milliseconds_elapsed each time, rising with real time, while the
    clock fields keep up with the wall clock to the second.

    Guards e68e6cfa4, the status cache: the sensors, the identity settings and
    the clock strings are cached (for a second, or until the second
    changes), and nothing that moves within a second may come from that
    cache. A build that caches the player's status with them fails this.
    """
    fppd.write("config/co-universes.json", ddp_output(30))
    fppd.settings(DisableFakeNetworkBridges="1")
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"),
               solid_frames(600, 30, 0x40), step_ms=50)  # 30 s
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    fppd.start()
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("milliseconds_elapsed", 0) > 0,
                  what="the sequence to start")

    samples = []
    end = time.monotonic() + 3
    while time.monotonic() < end:
        s = fppd.get("/fppd/status")
        samples.append((time.monotonic(), int(s["milliseconds_elapsed"]),
                        s["uptimeTotalSeconds"], s["time"]))
        time.sleep(0.1)
    assert len(samples) >= 15, f"only {len(samples)} polls in 3 s"

    ms = [m for _, m, _, _ in samples]
    stuck = [(a, b) for a, b in zip(ms, ms[1:]) if b <= a]
    assert not stuck, f"milliseconds_elapsed did not move between polls 100 ms apart: {stuck[:5]} in {ms}"
    rate = (ms[-1] - ms[0]) / ((samples[-1][0] - samples[0][0]) * 1000)
    assert 0.8 < rate < 1.2, f"milliseconds_elapsed ran at {rate:.2f}x real time: {ms}"

    uptimes = [u for _, _, u, _ in samples]
    assert uptimes[-1] - uptimes[0] >= 2, f"uptime did not keep up over 3 s: {uptimes}"
    assert len({t for _, _, _, t in samples}) >= 3, "the time string did not change over 3 s"
