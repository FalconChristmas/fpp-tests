"""The media position fppd reports, backed up by the sound card's own queue
(GStreamerOut's audio sink latency), on a device's real card.

pipewiresink reports what it has handed to the graph, not what has left
the card, so fppd subtracts the card's ALSA queue depth -- the `delay` in
/proc/asound/cardN/pcm0p/sub0/status of the card the graph feeds -- from
the position the sequence follows. Which card that is comes from FPP's
generated PipeWire confs. Each scenario plays a silent song in a playlist
through the device's own PipeWire and checks that the correction fppd
logs is that card's queue (read from /proc beside it), not nothing.

Needs a real card: run-local.sh --host-audio, on a device whose Simple
graph plays into a USB card's adapter declared after another card's
(verified on a Pi 4 with the headphone jack as card 0 and a USB card as
card 1). Silent, so nothing is heard.
"""

import contextlib
import os
import re
import subprocess
import tempfile
import time

import pytest

from audio import write_tone_wav
from fseq import write_fseq
from show import playlist

CONF = "/etc/pipewire/pipewire.conf.d/"
SINKS = CONF + "95-fpp-alsa-sink.conf"
GROUPS = CONF + "97-fpp-audio-groups.conf"
CORRECTED = re.compile(r"correcting reported position by ([\d.]+) ms of audio sink latency")


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def cards():
    """{ALSA card ID: index} from /proc/asound/cards."""
    return {m.group(2): int(m.group(1))
            for m in re.finditer(r"^\s*(\d+) \[(\S+)\s*\]", read("/proc/asound/cards"), re.M)}


def adapters(conf):
    """[(node name, ALSA card ID)] of the fpp_alsa_ sink adapters in a conf, in order."""
    out = []
    for block in re.split(r"\{ factory = adapter", conf)[1:]:
        name = re.search(r'node\.name = "(fpp_alsa_[^"]+)"', block)
        path = re.search(r'api\.alsa\.path = "[a-z]+:([^"]+)"', block)
        if name and path:
            out.append((name.group(1), path.group(1)))
    return out


def graph_card():
    """(card ID, its node) the device's Simple graph plays into, when it is
    not the first adapter its 95 conf declares -- or None."""
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        return None
    targets = re.findall(r'node\.target = "(fpp_alsa_[^"]+)"', read(GROUPS))
    declared = adapters(read(SINKS))
    if len(targets) != 1 or len(declared) < 2 or declared[0][0] == targets[0]:
        return None
    for name, cid in declared:
        if name == targets[0] and cid in cards():
            return cid, name, [c for n, c in declared if n != name][0]
    return None


GRAPH = graph_card()
needs_graph = pytest.mark.skipif(
    GRAPH is None, reason="needs run-local.sh --host-audio on a device whose Simple graph plays into "
                          "a card that is not the first in its 95 conf")


def play_and_read(fppd, audio_output):
    """Play a silent 12 s song in a playlist with AudioOutput set as given;
    the correction fppd logged (ms, or None) and the graph card's own queue
    in ms, read from /proc while it played."""
    cid = GRAPH[0]
    idx = cards()[cid]
    write_fseq(os.path.join(fppd.media, "sequences", "Quiet.fseq"), [bytes(8)] * 240)
    write_tone_wav(os.path.join(fppd.media, "music", "Quiet.wav"), 12, amplitude=0.0)
    fppd.write("playlists/Quiet.json", playlist("Quiet", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Quiet.fseq", "mediaName": "Quiet.wav"}]))
    fppd.settings(AudioOutput=audio_output, LogLevel_MediaOut="debug")
    fppd.start()
    fppd.command("Start Playlist", "Quiet", "false", "false")
    queue = []
    end = time.monotonic() + 8
    while time.monotonic() < end:
        st = read(f"/proc/asound/card{idx}/pcm0p/sub0/status")
        hw = read(f"/proc/asound/card{idx}/pcm0p/sub0/hw_params")
        d = re.search(r"^delay\s*:\s*(\d+)", st, re.M)
        r = re.search(r"^rate:\s*(\d+)", hw, re.M)
        if "RUNNING" in st and d and r:
            queue.append(int(d.group(1)) * 1000 / int(r.group(1)))
        time.sleep(0.1)
    fppd.command("Stop Now")
    m = CORRECTED.search(fppd.log())
    assert queue, f"card {cid} never ran: the song did not play through it"
    return (float(m.group(1)) if m else None), sorted(queue)[len(queue) // 2]


def assert_corrected_by(fppd, got, queue):
    print(f"correction {got} ms, card queue {queue:.1f} ms")
    assert got is not None, ("no sink latency correction was applied:\n"
                             + "\n".join(l for l in fppd.log().splitlines() if "GStreamer" in l)[-3000:])
    assert 0.5 * queue < got < 1.5 * queue, f"corrected by {got} ms; the card's queue was {queue:.1f} ms"


@needs_graph
def test_the_reported_position_is_backed_up_by_the_cards_queue(fppd, audio):
    """AudioOutput names the card the graph plays into: fppd corrects the
    media position by about that card's queue depth.

    Regression: 385b182e6 (the correction itself: the position was the
    one queued, and the lights led the sound by the queue, 22-160 ms) and
    11750d6c6 (the card it reads: the first adapter in the 95 conf, card 0
    here, whose PCM is closed -- so no correction at all on a box with
    more than one card)."""
    got, queue = play_and_read(fppd, GRAPH[0])
    assert_corrected_by(fppd, got, queue)


@needs_graph
def test_the_card_the_graph_feeds_wins_over_the_setting(fppd, audio):
    """AudioOutput names another card than the one the running graph plays
    into (changed, not yet applied): the correction still comes from the
    card the graph feeds.

    Regression: ef26935dc. The setting was matched first, so the card
    read was one not playing -- PCM closed, no correction."""
    got, queue = play_and_read(fppd, GRAPH[2])
    assert_corrected_by(fppd, got, queue)


@contextlib.contextmanager
def bound_over(path, text):
    """`text` over the file at `path`, for fppd in this run's mount
    namespace only (the device's PipeWire keeps reading the real one)."""
    d = tempfile.mkdtemp()
    src = os.path.join(d, os.path.basename(path))
    with open(src, "w") as f:
        f.write(text)
    subprocess.run(["mount", "--bind", src, path], check=True)
    try:
        yield
    finally:
        subprocess.run(["umount", path])


@needs_graph
def test_an_adapter_declared_only_in_the_groups_conf_is_found(fppd, audio):
    """The graph card's adapter is declared in the groups conf (97) rather
    than the boot conf (95), as for an HDMI card reached through
    sysdefault: -- here the device's own confs with that one adapter moved
    from 95 into 97, as fppd reads them: the correction still comes from
    that card.

    Regression: 8f106786f. Only 95 was searched, so such a card was never
    found: the correction came from the wrong card, or none."""
    cid, name, _ = GRAPH
    sinks = read(SINKS)
    moved = re.findall(r'  \{ factory = adapter\n    args = \{[^{}]*node\.name = "' + name
                       + r'"[^{}]*\}\n[^\n]*\n  \}\n', sinks)
    assert len(moved) == 1, sinks
    groups = "context.objects = [\n" + moved[0] + "]\n" + read(GROUPS)
    with bound_over(SINKS, sinks.replace(moved[0], "")), bound_over(GROUPS, groups):
        assert name not in [n for n, _ in adapters(read(SINKS))], "precondition: 95 no longer declares it"
        got, queue = play_and_read(fppd, cid)
    assert_corrected_by(fppd, got, queue)
