"""setupAudio (fppinit) writing the PipeWire ALSA config for the sound
cards a device really has, and PipeWire loading it.

Each scenario runs setupAudio in the fppinit sandbox against the device's
own /proc/asound with a stub aplay (setupaudio.py), checks what it wrote,
and then -- the receiving end -- loads the result into a PipeWire of its
own (CardGraph) with the real card, plays silence through it, and reads
what the card was opened with from /proc/asound.

Skipped where the card a scenario needs is missing (Docker has none); run
with run-local.sh on a device (verified on a Pi 4 with a USB card and the
headphone jack).
"""

import statistics
import time

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture
from setupaudio import CardGraph, adapter, box, group, onboard_card, usb_card
from test_fppinit_audio_cards import CONF, SINKS, carry, node, run

USB = usb_card()
ONBOARD = onboard_card()
needs_usb = pytest.mark.skipif(USB is None, reason="needs a USB sound card (run-local.sh on a device)")
needs_two = pytest.mark.skipif(USB is None or ONBOARD is None,
                               reason="needs a USB sound card and an onboard one (run-local.sh on a device)")


def queue_frames(graph, card, seconds=1.5):
    """The card's mean ALSA queue depth (delay, in frames) while silence
    plays into its adapter."""
    graph.play(f"fpp_alsa_{node(card[1])}", seconds=seconds + 3)
    assert graph.running(card[0]), f"card {card[1]} never started:\n{graph.daemon_log()}"
    time.sleep(0.5)
    samples = []
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        st, _ = graph.card_state(card[0])
        if st.get("delay", "").lstrip("-").isdigit():
            samples.append(int(st["delay"]))
        time.sleep(0.05)
    assert samples, f"no delay readings from card {card[1]}"
    return statistics.mean(samples)


@needs_two
def test_a_usb_card_alone_in_its_group_gets_less_headroom(fppinit):
    """A USB card that is the only sink in its group (Simple mode) gets an
    adapter with 1024 frames of api.alsa.headroom. Putting the onboard
    card in its group (Advanced mode) is noticed on the next run -- the
    card set is unchanged -- and the adapter goes back to 4096, the drift
    slack a card following another clock needs. Loaded into PipeWire with
    the real card, the shared-group adapter keeps about 3072 frames more
    queued at the card than the sole one.

    Regression: 1ce4f6432. Every USB card was charged 4096 frames, about
    70 ms more output latency than a card driving its own graph needs."""
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    out = run(fppinit)
    sole = fppinit.written(SINKS)
    a = adapter(sole, f"fpp_alsa_{n}")
    assert a, f"no adapter for {cid}:\n{sole}\n{out[-3000:]}"
    assert a["api.alsa.headroom"] == "1024", f"the sole USB sink's adapter:\n{a}"
    assert "sole sink in its group, headroom=1024" in out, out[-3000:]

    carry(fppinit)
    box(fppinit, "pipewire", cid, groups={"groups": [group("Main", cid, ONBOARD[1])]})
    fppinit.root_file(SINKS, sole)
    out = run(fppinit, media_home=True)
    assert "USB audio group membership has changed; re-probing" in out, out[-3000:]
    shared = fppinit.written(SINKS)
    assert adapter(shared, f"fpp_alsa_{n}")["api.alsa.headroom"] == "4096", shared

    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sole}) as g:
        assert g.wait_node(f"fpp_alsa_{n}"), g.daemon_log()
        q_sole = queue_frames(g, USB)
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": shared}) as g:
        assert g.wait_node(f"fpp_alsa_{n}"), g.daemon_log()
        q_shared = queue_frames(g, USB)
    print(f"queued at the card: {q_sole:.0f} frames sole, {q_shared:.0f} shared")
    assert 2000 < q_shared - q_sole < 4500, \
        f"queued at the card: {q_sole:.0f} frames sole, {q_shared:.0f} shared"


def plays(graph, card, target=None):
    """Silence played into `target` (the card's adapter by default) runs
    the card; its hw_params, or the assertion says why not."""
    target = target or f"fpp_alsa_{node(card[1])}"
    assert graph.wait_node(target), f"PipeWire made no {target} from the config:\n{graph.daemon_log()}"
    graph.play(target)
    got = graph.running(card[0])
    assert got, f"card {card[1]} never ran playing into {target}:\n{graph.daemon_log()}"
    return got[1]


@needs_usb
def test_a_format_aplay_refuses_after_its_banner_is_not_picked(fppinit):
    """The card advertises S16_LE and S32_LE, and the probe in S32_LE
    prints aplay's "Playing raw data" banner and then exits 1, as aplay
    does for a format the card refuses: the adapter is S16LE, and the real
    card plays in it.

    Regression: f11df50ed. The probe took the banner, which aplay prints
    before it negotiates anything, as success: the adapter was S32LE,
    which the card cannot open, and PipeWire made no node for it."""
    from setupaudio import dump, probe_result
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid, dumps={cid: dump(cid, formats="S16_LE S32_LE")})
    probe_result(fppinit, f"hw:{cid}", "S32_LE", "fail")
    out = run(fppinit)
    sinks = fppinit.written(SINKS)
    assert any("-f S32_LE" in c for c in fppinit.calls()), "S32_LE was never probed, so this proves nothing"
    a = adapter(sinks, f"fpp_alsa_{n}")
    assert a and a["audio.format"] == "S16LE", f"{a}\n{out[-3000:]}"
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks}) as g:
        assert plays(g, USB)["format"] == "S16_LE"


@needs_usb
def test_a_wider_format_that_costs_the_rate_is_not_picked(fppinit):
    """The card advertises S16_LE and S32_LE, but S32_LE opens only at
    22050 while S16_LE holds 44100 (a fixed bit clock): the adapter is
    S16LE, and the real card plays in it.

    Regression: 5b25cdad2. The widest advertised format was taken
    unprobed: S32LE, which PipeWire could not open at the graph rate -- on
    the cape this was found on it exited and was restarted forever; here
    (a card without S32) it makes no node."""
    from setupaudio import dump, probe_result
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid, dumps={cid: dump(cid, formats="S16_LE S32_LE", rates="[22050 44100]")})
    probe_result(fppinit, f"hw:{cid}", "S32_LE", 22050)
    out = run(fppinit)
    sinks = fppinit.written(SINKS)
    a = adapter(sinks, f"fpp_alsa_{n}")
    assert a and a["audio.format"] == "S16LE", f"{a}\n{out[-3000:]}"
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks}) as g:
        assert plays(g, USB)["format"] == "S16_LE"


@needs_usb
def test_a_sink_conf_from_older_probe_rules_is_reprobed(fppinit):
    """A 95-fpp-alsa-sink.conf naming exactly the cards present, but
    written under an older generation of the probe rules -- with a format
    the card refuses, as the rule the generation was bumped for wrote --
    is re-probed and rewritten under the current generation, and the card
    plays from the new one; from the old one PipeWire makes no node.

    Regression: 337525454. Only the set of cards was compared, so a conf
    the hardware rejects survived every upgrade."""
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    run(fppinit)
    good = fppinit.written(SINKS)
    gen = good.splitlines()[0]
    assert "(generation " in gen, gen
    old = int(gen.split("(generation ")[1].rstrip(")"))
    stale = good.replace(gen, f"# FPP ALSA sink adapters (generation {old - 1})", 1) \
        .replace('audio.format = "S16LE"', 'audio.format = "S32LE"')
    carry(fppinit)
    fppinit.root_file(SINKS, stale)
    out = run(fppinit)
    assert "ALSA sink config predates the current probe rules; re-probing" in out, out[-3000:]
    sinks = fppinit.written(SINKS)
    assert sinks and sinks.startswith(gen + "\n"), sinks
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": stale}) as g:
        assert g.wait_node(f"fpp_alsa_{n}", timeout=3) is None, "control: PipeWire made a node from the stale conf"
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks}) as g:
        assert plays(g, USB)["format"] == "S16_LE"


@needs_usb
def test_the_graph_runs_at_the_configured_rate_and_a_new_rate_reprobes(fppinit):
    """AudioFormat 44100: the sink conf sets default.clock.rate to 44100
    (90-fpp.conf says 48000), which the scenario's PipeWire runs at, and
    the card opens at 44100. Changing AudioFormat to 48000 makes the next
    run regenerate the cached conf, at 48000.

    Regression: c0d35f97f. The graph ran at 90-fpp.conf's 48000 against
    44100 adapters -- a resample on every cycle, playing or not -- and a
    new AudioFormat kept the cached conf."""
    from test_fppinit_audio_cards import set_setting
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    set_setting(fppinit, AudioFormat="1")
    run(fppinit)
    sinks = fppinit.written(SINKS)
    assert "default.clock.rate = 44100" in sinks, sinks
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks}) as g:
        assert g.clock_rate() == 44100, f"the graph clock: {g.clock_rate()}"
        assert plays(g, USB)["rate"].startswith("44100")
    carry(fppinit)
    set_setting(fppinit, AudioFormat="4")
    out = run(fppinit)
    assert "configured sample rate is now 48000; regenerating" in out, out[-3000:]
    assert "default.clock.rate = 48000" in fppinit.written(SINKS), fppinit.written(SINKS)


@needs_usb
def test_the_graph_clocks_at_the_rate_the_card_settles_on(fppinit):
    """AudioFormat 44100, and a card that refines a 44100 open up to 88200
    (as a fixed-bit-clock cape does): the sink conf clocks the graph at
    88200, and the scenario's PipeWire runs at it.

    Regression: 529b25f36. The graph was clocked at the requested 44100,
    so it resampled to the card's real rate for the life of the process."""
    from setupaudio import probe_result
    from test_fppinit_audio_cards import set_setting
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    set_setting(fppinit, AudioFormat="1")
    probe_result(fppinit, f"hw:{cid}", "S16_LE", 88200)
    out = run(fppinit)
    sinks = fppinit.written(SINKS)
    assert "default.clock.rate = 88200" in sinks, f"{sinks}\n{out[-3000:]}"
    assert f"({cid}) clocks at 88200, not the configured 44100" in out, out[-3000:]
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks}) as g:
        assert g.clock_rate() == 88200, f"the graph clock: {g.clock_rate()}"


@needs_usb
def test_a_card_that_refines_the_rate_keeps_its_cached_conf(fppinit):
    """The same refining card: the run after the one that wrote the conf
    keeps it ("skipping probe") and restarts nothing, while a real
    AudioFormat change to 48000 still re-probes.

    Regression: acd278035. The cache check compared the configured rate
    with default.clock.rate, which since 529b25f36 holds the achieved
    88200: they never matched, so every boot re-probed and restarted the
    stack to write the same file."""
    from setupaudio import probe_result
    from test_fppinit_audio_cards import set_setting
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    set_setting(fppinit, AudioFormat="1")
    probe_result(fppinit, f"hw:{cid}", "S16_LE", 88200)
    run(fppinit)
    assert "default.clock.rate = 88200" in fppinit.written(SINKS), "precondition: the card refined the rate"
    carry(fppinit)
    fppinit.write("config/pipewire-audio-groups.conf", fppinit.written(CONF + "97-fpp-audio-groups.conf"))
    fppinit.service("fpp-pipewire", active=True)
    out = run(fppinit)
    assert "ALSA sink adapters already match present cards; skipping probe" in out, out[-3000:]
    assert "configured sample rate is now" not in out, out[-3000:]
    restarts = [c for c in fppinit.calls() if c.startswith("systemctl restart fpp-pipewire")]
    assert not restarts, f"an unchanged conf restarted the stack: {restarts}\n{out[-3000:]}"
    carry(fppinit)
    set_setting(fppinit, AudioFormat="4")
    out = run(fppinit)
    assert "configured sample rate is now 48000; regenerating" in out, out[-3000:]


def hdmi_connector():
    """(the first vc4 HDMI card, its first connector's status file), or None."""
    import glob
    from setupaudio import proc_cards
    status = sorted(glob.glob("/sys/class/drm/card*-HDMI-A-1/status"))
    hdmi = [c for c in proc_cards() if c[1].startswith("vc4hdmi")]
    return (hdmi[0], status[0]) if status and hdmi else None


HDMI = hdmi_connector()


def as_booted(sb):
    """What the run before left, planted for the next: the confs (carry()),
    the groups conf's media cache, and the stack up as at boot."""
    carry(sb)
    groups = sb.written(CONF + "97-fpp-audio-groups.conf")
    if groups is not None:
        sb.write("config/pipewire-audio-groups.conf", groups)
    sb.service("fpp-pipewire", active=True)


def restarts(sb):
    return [c for c in sb.calls() if c.startswith("systemctl restart fpp-pipewire")]


@needs_usb
@pytest.mark.skipif(HDMI is None, reason="needs a vc4 HDMI card and its DRM connector (a Pi)")
def test_a_connected_hdmi_card_without_pcm_keeps_the_probe_cached(fppinit):
    """A display on the HDMI port (its connector reads "connected") whose
    card offers only IEC958 passthrough: the probe considers the card but
    writes it no adapter, and records it among the cards considered. The
    next run takes the cached conf ("skipping probe") and restarts nothing.

    Regression: 45900047d. The cache compared the adapters written with
    the cards considered, which never agree once a card is skipped: a Pi
    with a display re-probed on every boot."""
    from setupaudio import dump
    (hidx, hid, _, _), status = HDMI
    cid = USB[1]
    fppinit.fake_path(status, "connected\n")
    box(fppinit, "pipewire-simple", cid, dumps={
        cid: dump(cid), hid: dump(hid, formats="IEC958_SUBFRAME_LE", channels="[2 8]")})
    out = run(fppinit)
    assert f"skipping card {hidx} ({hid}) — no standard PCM format" in out, out[-3000:]
    sinks = fppinit.written(SINKS)
    assert node(hid) in next(l for l in sinks.splitlines() if l.startswith("# cards:")), sinks
    as_booted(fppinit)
    out = run(fppinit)
    assert "ALSA sink adapters already match present cards; skipping probe" in out, out[-3000:]
    assert not restarts(fppinit), f"{restarts(fppinit)}\n{out[-3000:]}"


@needs_usb
def test_a_card_pipewire_holds_keeps_its_adapter(fppinit):
    """The selected card is open in a PipeWire (the scenario's own, playing
    silence into it, as the device's is at postNetwork), so the probe's
    open fails busy: setupAudio takes the card's live format from /proc
    instead of skipping it, writes its adapter, and the card plays from
    the conf once it is free.

    Regression: 24b608f14. A card that would not open was dropped
    whatever the reason, so the card that was playing lost its adapter --
    and its sound, at the next PipeWire restart."""
    from setupaudio import dump
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    run(fppinit)
    held = fppinit.written(SINKS)
    box(fppinit, "pipewire-simple", cid,
        dumps={cid: "aplay: main:850: audio open error: Device or resource busy\n"})
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": held}) as g:
        assert g.wait_node(f"fpp_alsa_{n}"), g.daemon_log()
        g.play(f"fpp_alsa_{n}", seconds=60)
        assert g.running(USB[0]), g.daemon_log()
        out = run(fppinit)
    assert f"card {USB[0]} ({cid}) busy (held by PipeWire); using live params FORMAT=S16_LE" in out, out[-3000:]
    sinks = fppinit.written(SINKS)
    assert adapter(sinks, f"fpp_alsa_{n}"), f"the held card lost its adapter:\n{sinks}\n{out[-3000:]}"
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks}) as g:
        assert plays(g, USB)["format"] == "S16_LE"


@needs_two
def test_every_playback_card_gets_an_adapter_in_a_format_it_advertises(fppinit):
    """Two playback cards, the USB one selected: both get an fpp_alsa_
    adapter, each in the widest format it advertises (the USB card's
    S24_3LE, the onboard card's S16_LE beside U8), and each card plays
    from the conf in that format.

    Regression: e63830307. Only the selected card had an adapter (as
    S16LE whatever it advertised), so a group with the other card in it
    had nothing to play into."""
    from setupaudio import dump
    box(fppinit, "pipewire-simple", USB[1], dumps={
        USB[1]: dump(USB[1], formats="S16_LE S24_3LE", rates="[44100 96000]"),
        ONBOARD[1]: dump(ONBOARD[1], formats="U8 S16_LE", channels="[1 8]")})
    out = run(fppinit)
    sinks = fppinit.written(SINKS)
    usb = adapter(sinks, f"fpp_alsa_{node(USB[1])}")
    onboard = adapter(sinks, f"fpp_alsa_{node(ONBOARD[1])}")
    assert usb and onboard, f"{sinks}\n{out[-3000:]}"
    assert (usb["audio.format"], onboard["audio.format"]) == ("S24LE", "S16LE"), (usb, onboard)
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks}) as g:
        assert plays(g, USB)["format"] == "S24_3LE"
        assert plays(g, ONBOARD)["format"] == "S16_LE"


@needs_two
def test_a_usb_card_with_a_channel_range_gets_its_channels(fppinit):
    """A USB card advertising CHANNELS: [2 8] gets an 8-channel adapter,
    while the onboard card's [1 8] (a stereo jack whose driver lists its
    mixer subdevices as channels) stays stereo -- and plays in stereo.

    Regression: 47f32e2e7 (the USB half). A range was clamped to stereo
    for every card, so a multichannel USB card was opened with two
    channels. Its 8-channel adapter is checked only as written: no card
    here has 8 channels to play it on."""
    from setupaudio import dump
    box(fppinit, "pipewire-simple", ONBOARD[1], dumps={
        USB[1]: dump(USB[1], channels="[2 8]"),
        ONBOARD[1]: dump(ONBOARD[1], formats="U8 S16_LE", channels="[1 8]")})
    out = run(fppinit)
    sinks = fppinit.written(SINKS)
    usb = adapter(sinks, f"fpp_alsa_{node(USB[1])}")
    onboard = adapter(sinks, f"fpp_alsa_{node(ONBOARD[1])}")
    assert usb and onboard, f"{sinks}\n{out[-3000:]}"
    assert (usb["audio.channels"], onboard["audio.channels"]) == ("8", "2"), (usb, onboard)
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks.replace(
            f'node.name = "fpp_alsa_{node(USB[1])}"', 'node.name = "unused_8ch"')}) as g:
        assert plays(g, ONBOARD)["channels"] == "2"


@needs_usb
def test_adapters_name_cards_by_alsa_id(fppinit):
    """Each adapter opens its card as hw:<ALSA card ID>, which follows the
    card wherever it is numbered, and the card plays from it.

    Regression: df37bb28f (the boot conf half). Adapters were hw:<index>,
    which names a different card once a USB card enumerates in another
    order. (The duplicate-name suffixes in the AudioOutput list are the
    PHP half.)"""
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    run(fppinit)
    sinks = fppinit.written(SINKS)
    assert adapter(sinks, f"fpp_alsa_{n}")["api.alsa.path"] == f"hw:{cid}", sinks
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks}) as g:
        plays(g, USB)


@needs_two
def test_the_selected_card_is_found_by_id_after_the_cards_renumber(fppinit):
    """AudioOutput names the USB card by its ALSA ID, and another USB card
    has enumerated ahead of it (here a /proc/asound/cards where it is two
    places on): setupAudio still selects it -- AudioOutput keeps the ID,
    the Simple graph plays into its adapter -- and played through that
    graph, the real card runs.

    Regression: dcd34c76f. fppinit read AudioOutput as a card index, which
    moves with the probe order: an ID read as an index is card 0, the
    wrong card."""
    from setupaudio import dump, proc_cards
    from test_cape_detect import settings_of
    real = proc_cards()
    usb = next(c for c in real if c[1] == USB[1])
    others = [c for c in real if c[1] != USB[1]]
    shifted = [(0, others[0][1], others[0][2], others[0][3]), (1, "Device", "USB-Audio", "USB Audio Device"),
               (2, usb[1], usb[2], usb[3])] + [(i + 3, c[1], c[2], c[3]) for i, c in enumerate(others[1:])]
    box(fppinit, "pipewire-simple", USB[1], cards=shifted,
        dumps={USB[1]: dump(USB[1]), others[0][1]: dump(others[0][1])})
    out = run(fppinit)
    n = node(USB[1])
    assert settings_of(fppinit).get("AudioOutput") == USB[1], out[-3000:]
    groups = fppinit.written(CONF + "97-fpp-audio-groups.conf")
    assert f'node.target = "fpp_alsa_{n}"' in (groups or ""), f"{groups}\n{out[-3000:]}"
    sinks = fppinit.written(SINKS)
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": sinks, "97-fpp-audio-groups.conf": groups}) as g:
        plays(g, USB, target="fpp_group_default")


@needs_usb
def test_a_selected_card_that_is_absent_is_not_written_over(fppinit):
    """AudioOutput names a card that is not there (unplugged for the
    evening): this boot falls back to card 0, and AudioOutput keeps the
    user's choice. A legacy
    AudioOutput holding a card number is migrated to that card's ID (the
    control: the persisting itself works).

    Regression: 1edfb0484. The fallback card was persisted over the
    selection, so the card came back to a box set to the wrong output."""
    from test_cape_detect import settings_of
    box(fppinit, "pipewire-simple", "GoneCard")
    out = run(fppinit)
    assert "Audio device 'GoneCard' not currently present; falling back to card 0 for this boot" in out, out[-3000:]
    assert settings_of(fppinit).get("AudioOutput") == "GoneCard", out[-3000:]

    box(fppinit, "pipewire-simple", str(USB[0]))
    out = run(fppinit)
    assert f"Persisting selected audio device as ID '{USB[1]}'" in out, out[-3000:]
    assert settings_of(fppinit).get("AudioOutput") == USB[1]


GROUPS = CONF + "97-fpp-audio-groups.conf"
INPUTS = CONF + "96-fpp-input-groups.conf"


@needs_usb
def test_a_first_simple_boot_writes_its_graph_without_php(fppinit):
    """Simple mode on a first boot (no groups config at all): setupAudio
    writes the single-group graph itself -- the groups JSON, a 97 conf
    playing into the card's boot adapter, PipeWireSinkName -- without
    running the PHP apply, and silence played into fpp_group_default
    through that graph reaches the real card.

    Regression: adad3235d. Every first boot forked PHP for this (10-30 s on
    a single-core board), on the path to fppd."""
    from test_cape_detect import settings_of
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    out = run(fppinit)
    assert f"pipewire-simple: generating audio config in C++ (card {cid})" in out, out[-3000:]
    assert "regenerating from AudioOutput setting" not in out, out[-3000:]
    groups = fppinit.written(GROUPS)
    assert f'node.target = "fpp_alsa_{n}"' in (groups or ""), groups
    assert settings_of(fppinit).get("PipeWireSinkName") == "fpp_group_default"
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": fppinit.written(SINKS),
                                  "97-fpp-audio-groups.conf": groups}) as g:
        plays(g, USB, target="fpp_group_default")


@needs_usb
def test_a_first_advanced_boot_gets_default_groups_that_play(fppinit):
    """Advanced mode with no groups JSON yet: setupAudio creates one output
    group on the selected card and a mix bus that fppd_stream_1 feeds,
    routed to it; the groups are then generated into 96/97 confs, and
    silence played into the mix bus reaches the real card.

    Regression: 0da822cb1. A box switched to Advanced came up with no
    groups at all, so fppd's stream had nothing to play into."""
    import json as _json
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire", cid)
    out = run(fppinit, media_home=True)
    assert f"First PipeWire setup: creating default output group (card {cid}) and input group" in out, out[-3000:]
    og = _json.loads(fppinit.media_file("config/pipewire-audio-groups.json"))
    assert [m["cardId"] for m in og["groups"][0]["members"]] == [cid], og
    ig = _json.loads(fppinit.media_file("config/pipewire-input-groups.json"))
    bus = ig["inputGroups"][0]
    assert bus["outputs"] == [1] and bus["members"][0]["sourceId"] == "fppd_stream_1", ig
    confs = {"95-fpp-alsa-sink.conf": fppinit.written(SINKS), "97-fpp-audio-groups.conf": fppinit.written(GROUPS),
             "96-fpp-input-groups.conf": fppinit.written(INPUTS)}
    assert confs["97-fpp-audio-groups.conf"] and confs["96-fpp-input-groups.conf"], f"{confs}\n{out[-3000:]}"
    with CardGraph(fppinit.tree, confs) as g:
        plays(g, USB, target="fpp_input_mix_bus_1")


@needs_usb
def test_a_missing_groups_conf_is_restored_from_the_media_cache(fppinit):
    """The groups conf in /etc is gone (an OS upgrade, a cleanup) while its
    copy in the media directory is there: setupAudio puts it back, and the
    graph from it plays.

    Regression: bf60f7a48. Nothing restored it, so the group sinks fppd
    plays to were missing after the reboot. (Its other half -- a stale
    conf removed when the groups JSON is gone -- can no longer happen:
    0da822cb1 recreates the JSON first.)"""
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    run(fppinit)
    groups = fppinit.written(GROUPS)
    as_booted(fppinit)
    fppinit.root_file(GROUPS, None)
    out = run(fppinit)
    assert "Restoring PipeWire audio output groups config" in out, out[-3000:]
    assert fppinit.written(GROUPS) == groups, fppinit.written(GROUPS)
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": fppinit.written(SINKS),
                                  "97-fpp-audio-groups.conf": fppinit.written(GROUPS)}) as g:
        plays(g, USB, target="fpp_group_default")


@needs_usb
def test_a_simple_config_naming_an_absent_card_is_regenerated(fppinit):
    """The Simple groups JSON and its conf name a card that is not here:
    setupAudio regenerates them for the AudioOutput card, and that graph
    plays.

    Regression: fa2ce196a (its pipewire config check). A cached Simple
    config for a card that had gone was kept, pointing the default group
    at nothing."""
    from setupaudio import SIMPLE_JSON, group
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire-simple", cid)
    run(fppinit)
    as_booted(fppinit)
    fppinit.write(SIMPLE_JSON, {"groups": [group("Default", "GoneCard")]})
    gone = fppinit.written(GROUPS).replace(f"fpp_alsa_{n}", "fpp_alsa_gonecard")
    fppinit.root_file(GROUPS, gone)
    fppinit.write("config/pipewire-audio-groups.conf", gone)
    out = run(fppinit)
    assert f"pipewire-simple: generating audio config in C++ (card {cid})" in out, out[-3000:]
    assert "GoneCard" not in fppinit.media_file(SIMPLE_JSON)
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": fppinit.written(SINKS),
                                  "97-fpp-audio-groups.conf": fppinit.written(GROUPS)}) as g:
        plays(g, USB, target="fpp_group_default")


@needs_usb
def test_a_group_member_on_an_absent_card_regenerates_before_pipewire_starts(fppinit):
    """Advanced mode, a group whose member names a card that is not here,
    and a cached conf (matching what was loaded) still holding that card's
    adapter: setupAudio does not accept it but regenerates the groups
    without the adapter, and the scenario's PipeWire starts on the result
    with the group's sink in it.

    Regression: 0bcb61036. The cached conf was loaded as it was, and an
    adapter for an unplugged card takes PipeWire down."""
    from setupaudio import group
    cid, n = USB[1], node(USB[1])
    box(fppinit, "pipewire", cid, groups={"groups": [group("Main", cid)]})
    run(fppinit, media_home=True)
    assert fppinit.written(GROUPS), "precondition: the first run generated the groups"
    as_booted(fppinit)
    # As generated while the other card was here: its adapter and all.
    gone = ('context.objects = [\n  { factory = adapter\n    args = {\n'
            '      factory.name = api.alsa.pcm.sink\n      node.name = "fpp_alsa_gonecard"\n'
            '      media.class = "Audio/Sink"\n      api.alsa.path = "hw:GoneCard"\n'
            '      audio.format = "S16LE"\n      audio.rate = 44100\n      audio.channels = 2\n'
            '    }\n  }\n]\n') + fppinit.written(GROUPS)
    fppinit.root_file(GROUPS, gone)
    fppinit.write("config/pipewire-audio-groups.conf", gone)
    # In a group of its own: one beside the USB card would change that
    # card's headroom, which regenerates for a reason of its own.
    fppinit.write("config/pipewire-audio-groups.json", {"groups": [
        group("Main", cid), group("Other", "GoneCard", gid=2)]})
    out = run(fppinit, media_home=True)
    assert "skipping regeneration" not in out, out[-3000:]
    assert "Validating PipeWire audio group config against current hardware" in out, out[-3000:]
    groups = fppinit.written(GROUPS) or fppinit.media_file("config/pipewire-audio-groups.conf")
    assert "hw:GoneCard" not in groups and "fpp_alsa_gonecard" not in groups, groups
    with CardGraph(fppinit.tree, {"95-fpp-alsa-sink.conf": fppinit.written(SINKS),
                                  "97-fpp-audio-groups.conf": groups}) as g:
        assert g.wait_node("fpp_group_main"), g.daemon_log()


@needs_usb
def test_a_cape_asoundrc_is_not_used_under_pipewire(fppinit):
    """A cape that ships its own (softvol) asoundrc, on a pcm510x codec,
    with MediaBackend PipeWire: /root/.asoundrc is FPP's PipeWire template,
    and ALSA reading it offers the pipewire PCM, not the cape's.

    Regression: b27b928ce. The cape's asoundrc won even under PipeWire, so
    ALSA clients (flite, aplay) went around the graph to the card."""
    import subprocess
    import tempfile
    cid = USB[1]
    box(fppinit, "pipewire", cid, names={cid: "[snd_rpi_hifiberry_dac pcm5102a], device 0: x [x]"},
        groups={"groups": [group("Main", cid)]})
    fppinit.write("tmp/asoundrc", "pcm.capesoftvol {\n    type softvol\n    slave.pcm \"hw:0\"\n"
                  "    control.name \"PCM\"\n}\npcm.!default {\n    type plug\n    slave.pcm capesoftvol\n}\n")
    out = run(fppinit, media_home=True)
    rc = fppinit.written("/root/.asoundrc") or ""
    assert "capesoftvol" not in rc and "type pipewire" in rc, f"{rc}\n{out[-3000:]}"
    home = tempfile.mkdtemp()
    with open(home + "/.asoundrc", "w") as f:
        f.write(rc)
    pcms = subprocess.run(["aplay", "-L"], env={"HOME": home, "PATH": "/usr/bin:/bin"},
                          capture_output=True, text=True).stdout
    assert "pipewire" in pcms.split() and "capesoftvol" not in pcms.split(), pcms


@pytest.mark.skipif(ONBOARD is None or ONBOARD[0] != 0, reason="needs the onboard card as card 0 (a Pi)")
def test_an_i2s_hat_gets_no_headphone_jack_volume_lift(fppinit):
    """A Pi whose card 0 is an I2S HAT (bcm2835-i2s in its aplay line): the
    mixer is set to the volume setting as it is (70%). The Pi's own
    headphone jack still gets its lift, (70 / 2) + 50 = 85% (the control).

    Regression: 4c5c2cae6. Every [bcm2... card 0 got the lift, an I2S HAT
    included, so it played louder than set."""
    import os
    if not os.path.exists("/proc/device-tree/model") or "Raspberry" not in open("/proc/device-tree/model").read():
        pytest.skip("the headphone jack lift is Pi only")
    cid = ONBOARD[1]

    def mixer_set():
        return [c for c in fppinit.calls() if c.startswith("amixer -c 0 set")]
    box(fppinit, "pipewire-simple", cid)
    run(fppinit)
    assert mixer_set() == ["amixer -c 0 set PCM 85%"], f"control: the jack's lift: {mixer_set()}"
    box(fppinit, "pipewire-simple", cid, names={cid: "[bcm2835-i2s-pcm5102a-hifi pcm5102a-hifi-0], "
                                                     "device 0: bcm2835-i2s-pcm5102a-hifi pcm5102a-hifi-0 [x]"})
    run(fppinit)
    assert mixer_set() == ["amixer -c 0 set PCM 70%"], mixer_set()


@pytest.mark.skipif(HDMI is None, reason="needs a vc4 HDMI connector (a Pi)")
def test_a_single_hdmi_card_plays_through_sysdefault(fppinit):
    """A Pi whose only card is a single-port vc4 HDMI card ("vc4hdmi", no
    index), offering only IEC958 on hw: and PCM through sysdefault:, with
    a display connected: it is selected rather than declared dead, and the
    Simple graph plays into an adapter on sysdefault:vc4hdmi.

    Regression: f815372b4. The plain "vc4hdmi" card never matched the
    per-port status, so it read as unconnected and AudioOutput fell back
    to card 0; and its adapter was hw:, which PipeWire cannot open on a
    passthrough-only card. Checked as written only: playing to HDMI
    needs a display (none here), and nothing here opens the card."""
    from setupaudio import dump
    from test_cape_detect import settings_of
    _, status = HDMI
    fppinit.fake_path(status, "connected\n")
    box(fppinit, "pipewire-simple", "vc4hdmi", cards=[(0, "vc4hdmi", "vc4-hdmi", "vc4-hdmi")],
        dumps={"vc4hdmi": dump("vc4hdmi", formats="IEC958_SUBFRAME_LE")})
    fppinit.stub_output("aplay", "sysdefault:vc4hdmi", dump("vc4hdmi", formats="S16_LE S32_LE"))
    out = run(fppinit)
    assert "has no HDMI connected" not in out, out[-3000:]
    assert settings_of(fppinit).get("AudioOutput") == "vc4hdmi", out[-3000:]
    groups = fppinit.written(GROUPS) or ""
    a = adapter(groups, "fpp_alsa_vc4hdmi")
    assert a and a["api.alsa.path"] == "sysdefault:vc4hdmi", f"{groups}\n{out[-3000:]}"
