"""Which PipeWire nodes the master volume (/fppd/volume) lands on, read back
from PipeWire itself, and, for a network sender, from the audio it puts on
the wire. Sinks are null sinks on the audio fixture's PipeWire standing in
for a card adapter (fpp_alsa_*), an output group's combine sink and a node
WirePlumber publishes for a card (alsa_output.*)."""

import os
import statistics
import subprocess
import time

from audio import write_tone_wav
from test_audio_backends import add_sink
from test_volume_pipewire import sink_state

GROUPS = "config/pipewire-audio-groups.json"


class Feeder:
    """Keeps each sink running with a quiet tone: a suspended null sink
    doesn't take a volume."""

    def __init__(self, audio, path, sinks):
        self.procs = [subprocess.Popen(["pw-cat", "--playback", "--target", s, path], env=audio.env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                      for s in sinks]

    def close(self):
        for p in self.procs:
            p.terminate()
            p.wait(5)


def feeder(fppd, audio, sinks):
    path = os.path.join(fppd.media, "music", "Feed.wav")
    write_tone_wav(path, 60, amplitude=0.05)
    f = Feeder(audio, path, sinks)
    deadline = time.monotonic() + 10
    while True:
        out = subprocess.run(["pactl", "list", "sinks", "short"], env=audio.env, capture_output=True,
                             text=True).stdout
        running = {l.split("\t")[1] for l in out.splitlines() if "RUNNING" in l}
        if set(sinks) <= running:
            return f
        assert time.monotonic() < deadline, f"sinks never ran: {sorted(running)}"
        time.sleep(0.2)


def wait_for_levels(audio, want, timeout=10):
    """Until every sink in `want` is at its (volume %, muted)."""
    deadline = time.monotonic() + timeout
    while True:
        got = {s: sink_state(audio, s) for s in want}
        if got == want:
            return
        if time.monotonic() > deadline:
            return got
        time.sleep(0.2)


def set_sink_volume(audio, sink, pct):
    subprocess.run(["pactl", "set-sink-volume", sink, f"{pct}%"], env=audio.env, check=True, timeout=10)


def test_the_master_volume_reaches_a_group_member_wireplumber_publishes(fppd, audio):
    """An output group of two members, an FPP card adapter (fpp_alsa_*) and
    a node WirePlumber publishes for a card (alsa_output.*, as an HDMI
    output arrives): /fppd/volume/40 puts both at 40%.

    Regression: ab45029d5. The master found its sinks by prefix
    (fpp_alsa_*, aes67_*), so a member targeting a WirePlumber node was
    left at 100% while the rest of its group went down: the master
    unbalanced the group, and on an HDMI-only box did nothing."""
    card, hdmi = "fpp_alsa_test", "alsa_output.test.hdmi-stereo"
    add_sink(audio, card, ["FL", "FR"])
    add_sink(audio, hdmi, ["FL", "FR"])
    fppd.settings(MediaBackend="pipewire")
    fppd.write(GROUPS, {"groups": [{"id": 1, "name": "Main", "enabled": True, "members": [
        {"cardId": "test", "nodeTarget": card}, {"cardId": "hdmi", "nodeTarget": hdmi}]}]})
    feed = feeder(fppd, audio, [card, hdmi])
    try:
        fppd.start()
        fppd.post("/fppd/volume/40")
        got = wait_for_levels(audio, {card: (40, False), hdmi: (40, False)})
    finally:
        feed.close()
    assert got is None, f"after /fppd/volume/40: {got}"


def test_the_master_volume_leaves_the_output_groups_volume_alone(fppd, audio):
    """With the primary output group's sink (PipeWireSinkName) at 50% --
    as the volume restore leaves it before fppd starts -- and the master at
    70, fppd starting puts the card sink at 70% and leaves the group at 50%:
    master and group multiply.

    Regression: ae0d41489. setVolume() wrote the master straight to
    PipeWireSinkName, the group's own node, so at every start fppd
    overwrote the group's restored volume with the master's."""
    card, group = "fpp_alsa_test", "fpp_group_main"
    add_sink(audio, card, ["FL", "FR"])
    add_sink(audio, group, ["FL", "FR"])
    fppd.settings(MediaBackend="pipewire", PipeWireSinkName=group, volume="70")
    feed = feeder(fppd, audio, [card, group])
    try:
        set_sink_volume(audio, group, 50)
        set_sink_volume(audio, card, 100)
        fppd.start()
        # The master is applied by a worker thread just after start.
        got = wait_for_levels(audio, {card: (70, False), group: (50, False)})
        time.sleep(1)
        after = {s: sink_state(audio, s) for s in (card, group)}
    finally:
        feed.close()
    assert got is None, f"fppd started with the master at 70: {got}"
    assert after == {card: (70, False), group: (50, False)}, f"a second later: {after}"


def test_the_master_volume_reaches_an_aes67_sender(fppd, audio):
    """An AES67 send instance fed from the test sink's monitor, on a box
    with a card sink too: a tone's level in the RTP payload follows the
    master -- at 50 it is 0.125 of what it was at 100 (the master's cubic
    taper), and the card sink goes to 50% as well.

    Regression: cb540333c. The master looked for the sender among the
    sinks by name (aes67_*), but its node is pipewiresrc's capture stream,
    so set-sink-volume found nothing and the sender stayed at full level.
    Not covered: the Opus RTP sender's half (the same volume element, in
    OpusRTPManager)."""
    from rtp_capture import RtpCapture
    from test_aes67_wire import start_sender, window
    card = "fpp_alsa_test"
    add_sink(audio, card, ["FL", "FR"])
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 40, amplitude=0.5)
    feed = feeder(fppd, audio, [card])
    try:
        with RtpCapture(5004) as cap:
            start_sender(fppd, audio, ptpEnabled=False)
            fppd.command("Play Media", "Tone.wav", "1", "0", "1")
            time.sleep(2)
            full = statistics.median(p.peak() for p in window(cap, 1.0))
            fppd.post("/fppd/volume/50")
            time.sleep(2)
            half = statistics.median(p.peak() for p in window(cap, 1.0))
        card_level = sink_state(audio, card)
    finally:
        feed.close()
    assert full > 0.3, f"precondition: the tone reached the sender at {full:.3f}"
    assert abs(half / full - 0.125) < 0.03, f"RTP level at master 50 vs 100: {half:.3f} / {full:.3f}"
    assert card_level == (50, False), f"the card sink: {card_level}"
