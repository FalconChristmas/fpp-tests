"""Playlist sections: lead-in, a looping main section, lead-out, and how the
two stop commands treat them. Each sequence is one solid value, so the order
of sections shows directly on the wire."""

import os
import time

from ddp import DdpReceiver
from fseq import solid_frames, write_fseq
from show import CHANNELS, ddp_output, playlist, sequence_entry, status

SECTION_FRAMES = 30          # 1.5 s at 50 ms
SECTION_S = SECTION_FRAMES * 0.05
LEAD_IN, MAIN, LEAD_OUT = 10, 20, 30


def install_sections(fppd):
    for name, value in (("In", LEAD_IN), ("Main", MAIN), ("Out", LEAD_OUT)):
        write_fseq(os.path.join(fppd.media, "sequences", name + ".fseq"),
                   solid_frames(SECTION_FRAMES, CHANNELS, value))
    fppd.write("playlists/Show.json", playlist(
        "Show", [sequence_entry("Main.fseq")], lead_in=[sequence_entry("In.fseq")],
        lead_out=[sequence_entry("Out.fseq")], repeat=1))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")


def runs(rx):
    """[(value, first time, last time)] for each stretch of one value."""
    out = []
    for t, d in rx.snapshot():
        if out and out[-1][0] == d[0]:
            out[-1][2] = t
        else:
            out.append([d[0], t, t])
    return out


def wait_idle(fppd):
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20,
                  interval=0.2, what="the playlist to stop")


def test_stop_gracefully_finishes_the_pass_then_plays_the_lead_out(fppd):
    """Lead-in once, main looping; Stop Gracefully lets the main pass in
    progress finish, plays the whole lead-out, then goes idle and dark."""
    with DdpReceiver(CHANNELS) as rx:
        install_sections(fppd)
        fppd.start()
        fppd.command("Start Playlist", "Show", "true", "false")
        time.sleep(4.5)  # into the main section's third pass
        assert status(fppd).get("current_sequence") == "Main.fseq", status(fppd)
        asked = time.monotonic()
        fppd.command("Stop Gracefully")
        wait_idle(fppd)
        time.sleep(0.5)
        seen = [(v, a, b) for v, a, b in runs(rx) if v]
        order = [v for v, _, _ in seen]
        assert order == [LEAD_IN, MAIN, LEAD_OUT], f"sections played in order {order}"
        _, out_start, out_end = seen[2]
        assert out_start >= asked, "the lead-out started before Stop Gracefully"
        assert out_start - asked <= SECTION_S + 0.5, \
            f"lead-out began {out_start - asked:.2f} s after the stop: more than one main pass"
        assert out_end - out_start >= SECTION_S - 0.3, \
            f"lead-out cut short: {out_end - out_start:.2f} s of {SECTION_S} s"
        assert not any(rx.last()), "output left lit after the lead-out"


def test_stop_now_skips_the_lead_out(fppd):
    """Stop Now ends the playlist where it is: no lead-out, straight to dark."""
    with DdpReceiver(CHANNELS) as rx:
        install_sections(fppd)
        fppd.start()
        fppd.command("Start Playlist", "Show", "true", "false")
        time.sleep(3)
        fppd.command("Stop Now")
        wait_idle(fppd)
        time.sleep(0.5)
        order = [v for v, _, _ in runs(rx) if v]
        assert LEAD_OUT not in order, f"Stop Now played the lead-out: {order}"
        assert not any(rx.last()), "output left lit after Stop Now"
