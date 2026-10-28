"""fppinit's setupAudio on boards whose sound cards are faked: none at all,
only the synthetic snd-dummy, or a card a device tree declares.

The fppinit sandbox (fppinit.py) normally sees the machine's own
/proc/asound and device tree, and Docker has neither. Here fakesys.c is
preloaded into fppinit and serves both from files the scenario writes in
the sandbox's state directory, so they can change during the run: the
stubbed modprobe registers snd-dummy's card in the fake /proc/asound/cards
when it is asked to load it, as the kernel would.
"""

import os
import time

import shims
from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit_audio_cards import set_setting

DUMMY_LINE = " 0 [Dummy          ]: Dummy - Dummy\n                      Dummy\n"

# modprobe as the kernel answers it for snd-dummy: its card registers.
MODPROBE = f"""#!/bin/sh
echo "modprobe $*" >> /fppinit-calls.log
case "$*" in *snd-dummy*|*snd_dummy*) printf '%s' {DUMMY_LINE!r} >> /fppinit-state/asound/cards ;; esac
exit 0
"""


def fake_boards(sb, cards="", device_tree=None):
    """The fake /proc/asound/cards (`cards`, as the kernel prints it) and,
    if given, a fake /proc/device-tree ({relative path: content})."""
    os.makedirs(os.path.join(sb.state, "asound"), exist_ok=True)
    with open(os.path.join(sb.state, "asound", "cards"), "w") as f:
        f.write(cards or "--- no soundcards ---\n")
    maps = ["/proc/asound=/fppinit-state/asound"]
    if device_tree is not None:
        for rel, text in device_tree.items():
            path = os.path.join(sb.state, "dt", rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text)
        os.makedirs(os.path.join(sb.state, "dt"), exist_ok=True)
        maps.append("/proc/device-tree=/fppinit-state/dt")
    sb.root_file("/usr/sbin/modprobe", MODPROBE)
    with open(shims.build("fakesys.c"), "rb") as f:
        sb.write_bytes("fakesys.so", f.read())
    return ":".join(maps)


def setup_audio(sb, maps, timeout=240, env=()):
    """One setupAudio with fakesys preloaded, and `env` ("NAME=value"
    strings) as well; (output, seconds taken)."""
    # Not after the sanitizer runtime, as fppd's preloads go: fppinit's
    # children inherit LD_PRELOAD, and with libasan in it some of them die
    # of SIGILL. ASan only has to be told not to insist on coming first.
    t = time.monotonic()
    r = sb._run(["/usr/bin/env", "LD_PRELOAD=/fpp-test-media/fakesys.so", "FAKESYS=" + maps,
                 "ASAN_OPTIONS=verify_asan_link_order=0:detect_leaks=0", *env,
                 "/opt/fpp/src/fppinit", "setupAudio"], timeout=timeout,
                media_home=True)  # fppinit of 10.0 read /home/fpp/media only
    took = time.monotonic() - t
    out = r.stdout + r.stderr
    assert "AddressSanitizer" not in out and "terminate called" not in out, out[-3000:]
    assert r.returncode == 0, f"fppinit exited {r.returncode}:\n{out[-3000:]}"
    return out, took


def modprobes(sb):
    return [c for c in sb.calls() if c.startswith("modprobe ")]


def test_a_dummy_selection_loads_snd_dummy_without_waiting_for_it(fppinit):
    """A board with no sound card whose AudioOutput is "Dummy" (what it is
    set to once snd-dummy has stood in): setupAudio loads snd-dummy at
    once, and never waits for a card named Dummy to register.

    Regression: 21fb47285 (the Dummy half). The selected card was waited
    for like any other, 10 s for a card that only registers because
    setupAudio loads snd-dummy -- which it did only after the wait, so a
    capeless board spent 10 s of every boot on it."""
    maps = fake_boards(fppinit)
    fppinit.settings(AudioOutput="Dummy")
    out, took = setup_audio(fppinit, maps)
    assert any("snd-dummy" in m or "snd_dummy" in m for m in modprobes(fppinit)), (modprobes(fppinit), out[-3000:])
    assert "Waiting for audio device 'Dummy'" not in out, out[-3000:]
    assert "did not appear after" not in out, out[-3000:]


def test_a_disabled_device_tree_sound_node_is_not_waited_for(fppinit):
    """A board with no sound card whose device tree has a sound node with
    status "disabled" (an AM62x board without its audio cape's overlay):
    setupAudio doesn't wait for a card to bind. The same node with status
    "okay" -- the control -- does wait, so the fake device tree is read.

    Regression: 21fb47285 (the device-tree half). Any sound node counted as
    audio hardware on its way, so every capeless board of that kind waited
    the full 5 s bind wait for a card that could never bind."""
    for status, waits in (("disabled", False), ("okay", True)):
        # The run before persisted the stand-in it fell back on.
        set_setting(fppinit, AudioOutput="")
        maps = fake_boards(fppinit, device_tree={"model": "A test board\0",
                                                 "sound/compatible": "simple-audio-card\0",
                                                 "sound/status": status + "\0"})
        out, took = setup_audio(fppinit, maps)
        waited = "audio hardware is present; waiting" in out
        assert waited == waits, f'sound node "{status}": waited {waited}:\n{out[-3000:]}'


GROUPS_CONF = "/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf"

# The groups conf an FPP before the null sink wrote for snd-dummy: a real
# ALSA adapter on it, behind the combine-stream group sink.
OLD_DUMMY_CONF = """# Auto-generated by FPP - PipeWire Audio Output Groups
context.objects = [
  { factory = adapter
    args = {
      factory.name = api.alsa.pcm.sink
      node.name = "fpp_alsa_dummy"
      api.alsa.path = "hw:Dummy"
      audio.channels = 2
      audio.position = [ FL FR ]
    }
  }
]
context.modules = [
  { name = libpipewire-module-combine-stream
    args = {
      combine.mode = sink
      node.name = "fpp_group_default"
      node.description = "Default"
      combine.props = { audio.position = [ FL FR ] }
      stream.rules = [
        { matches = [ { media.class = "Audio/Sink" node.name = "fpp_alsa_dummy" } ]
          actions = { create-stream = { } } }
      ]
    }
  }
]
"""


def no_card_box(sb):
    """A board whose only card is snd-dummy, set to it (as a box with no
    sound card is, once it has booted), in Simple mode, outside Docker."""
    maps = fake_boards(sb, cards=DUMMY_LINE)
    sb.root_file("/.dockerenv", None)  # setupAudio leaves PipeWire alone in a container
    set_setting(sb, AudioOutput="Dummy", MediaBackend="pipewire-simple")
    # The group sink comes up, so setupAudio doesn't wait 30 s for it.
    sb.stub_output("pactl", "list", "1\tfpp_group_default\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n")
    return maps


def test_a_no_card_boards_cached_alsa_graph_becomes_a_null_sink(fppinit):
    """A board with no sound card upgraded from an FPP that gave snd-dummy
    a real ALSA adapter behind the group sink: its cached groups conf still
    has that graph, and the Simple groups file still names Dummy, so every
    check of the cache passes. setupAudio regenerates it once anyway, into
    a support.null-audio-sink, and the boot after leaves that alone.

    Regression: 5779cff48. Nothing noticed the cached graph was the old
    form, so the board kept it on every boot -- a graph on hw:Dummy that
    never idles, cycling PipeWire ~47 times a second for nothing."""
    maps = no_card_box(fppinit)
    out, _ = setup_audio(fppinit, maps)
    fresh = fppinit.written(GROUPS_CONF) or ""
    assert "support.null-audio-sink" in fresh, f"precondition: a fresh run's groups conf:\n{fresh}\n{out[-3000:]}"

    # In /etc and in the media directory's copy, which a boot restores /etc from.
    fppinit.root_file(GROUPS_CONF, OLD_DUMMY_CONF)
    fppinit.write("config/pipewire-audio-groups.conf", OLD_DUMMY_CONF)
    out, _ = setup_audio(fppinit, maps)
    regenerated = fppinit.written(GROUPS_CONF) or ""
    assert "support.null-audio-sink" in regenerated and "hw:Dummy" not in regenerated, \
        f"the cached hw:Dummy graph after a boot:\n{regenerated}\n{out[-3000:]}"

    fppinit.root_file(GROUPS_CONF, regenerated)
    out, _ = setup_audio(fppinit, maps)
    assert "predates the null sink" not in out, f"regenerated again:\n{out[-3000:]}"


def test_a_board_with_no_sound_card_gets_a_null_sink_that_plays_in_real_time(fppinit):
    """A board whose only card is snd-dummy, booting in Simple mode for the
    first time: setupAudio's groups conf makes fpp_group_default a
    support.null-audio-sink rather than a graph on hw:Dummy. Loaded into a
    PipeWire of the scenario's own (CardGraph), that is an Audio/Sink, and
    3 s of audio played into it takes 3 s -- so media on such a board still
    runs in real time and the sequence keeps its timing.

    Regression: 9a784598d (the boot-time C++ half). The groups conf was the
    normal hw:Dummy adapter -> combine-stream graph, which keeps the dummy
    PCM open and never lets the graph idle (~47 wakeups/s on a board that
    can make no sound). Not covered: the PHP half (GroupsAreDummyOnly() in
    the Advanced generator)."""
    from setupaudio import CardGraph
    maps = no_card_box(fppinit)
    out, _ = setup_audio(fppinit, maps)
    conf = fppinit.written(GROUPS_CONF) or ""
    assert "support.null-audio-sink" in conf and "hw:Dummy" not in conf, f"the groups conf:\n{conf}\n{out[-3000:]}"
    with CardGraph(fppinit.tree, {"97-fpp-audio-groups.conf": conf}) as g:
        node = g.wait_node("fpp_group_default")
        assert node, g.daemon_log()
        assert node.get("media.class") == "Audio/Sink" and node.get("factory.name") == "support.null-audio-sink", node
        t = time.monotonic()
        p = g.play("fpp_group_default", seconds=3)
        p.wait(20)
        took = time.monotonic() - t
        assert p.returncode == 0 and 2.7 <= took <= 6, f"3 s into the null sink: exit {p.returncode} after {took:.2f} s\n{g.daemon_log()}"


def test_an_audio_format_with_a_bit_depth_is_stored_as_its_rate(fppinit):
    """AudioFormat values that carried a sample format as well as a rate
    (2 and 3 for 44100, 5 and 6 for 48000, 8 and 9 for 96000) are folded
    onto the rate's own value (1, 4, 7) at boot, which is all the A/V
    settings page now offers; a plain rate is left alone.

    Regression: a67486841 (the boot half). The page dropped the bit-depth
    variants, but a box that had one stored kept it, which the dropdown
    showed as no selection and saved as 44100 the first time the page was
    saved."""
    from test_fppinit_audio_cards import set_setting
    maps = fake_boards(fppinit)
    seen = {}
    for stored, want in (("5", "4"), ("9", "7"), ("2", "1"), ("4", "4")):
        set_setting(fppinit, AudioFormat=stored)
        out, _ = setup_audio(fppinit, maps)
        lines = [l for l in open(os.path.join(fppinit.media, "settings")).read().splitlines()
                 if l.split("=", 1)[0].strip() == "AudioFormat"]
        seen[stored] = lines
        assert lines == [f'AudioFormat = "{want}"'], (seen, out[-2000:])


HDMI_AND_JACK = (" 0 [vc4hdmi0      ]: vc4-hdmi - vc4-hdmi-0\n                      vc4-hdmi-0\n"
                 " 1 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n"
                 "                      bcm2835 Headphones\n")
HDMI_AND_JACK_APLAY = ("**** List of PLAYBACK Hardware Devices ****\n"
                       "card 0: vc4hdmi0 [vc4-hdmi-0], device 0: MAI PCM i2s-hifi-0 [MAI PCM i2s-hifi-0]\n"
                       "  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n"
                       "card 1: Headphones [bcm2835 Headphones], device 0: bcm2835 Headphones [bcm2835 Headphones]\n"
                       "  Subdevices: 8/8\n  Subdevice #0: subdevice #0\n")


def test_an_hdmi_selection_with_no_display_is_kept_through_a_fallback_boot(fppinit):
    """A Pi whose AudioOutput is its HDMI port's card, booting with no
    display connected (the TV is off): setupAudio plays this boot on the
    headphone jack, and says so in /run/fppd/audio-output.json (selected
    vc4hdmi0, effective Headphones, fallback), but AudioOutput stays
    vc4hdmi0 for the boots after.

    Regression: 41a7f0e24 (setupAudio's half). The fallback card was saved
    into AudioOutput, so a show controller whose TV was off at one boot
    stayed on the headphone jack on every boot after, display or not. Not
    covered: fppd's and the PHP apply's reading of the effective card."""
    import json
    from test_fppinit_audio_cards import set_setting
    maps = fake_boards(fppinit, cards=HDMI_AND_JACK)
    os.makedirs(os.path.join(fppinit.state, "run-fppd"), exist_ok=True)
    maps += ":/run/fppd=/fppinit-state/run-fppd"
    fppinit.root_file("/.dockerenv", None)  # nothing is written to /run in a container
    fppinit.stub_output("aplay", "-l", HDMI_AND_JACK_APLAY)
    fppinit.stub_output("amixer", "scontrols", "Simple mixer control 'PCM',0\n")
    fppinit.stub_output("pactl", "list", "1\tfpp_alsa_headphones\tPipeWire\ts16le 2ch 44100Hz\tSUSPENDED\n")
    set_setting(fppinit, AudioOutput="vc4hdmi0", MediaBackend="pipewire-simple")
    out, _ = setup_audio(fppinit, maps)
    assert "has no HDMI connected" in out, f"precondition: the HDMI card wasn't taken as dead:\n{out[-3000:]}"
    kept = [l for l in open(os.path.join(fppinit.media, "settings")).read().splitlines()
            if l.split("=", 1)[0].strip() == "AudioOutput"]
    assert kept == ['AudioOutput = "vc4hdmi0"'], (kept, out[-3000:])
    eff = fppinit.written("/fppinit-state/run-fppd/audio-output.json")
    assert eff, f"no /run/fppd/audio-output.json:\n{out[-3000:]}"
    assert json.loads(eff) == {"selected": "vc4hdmi0", "effective": "Headphones", "fallback": True}, eff


JACK = " 0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n                      bcm2835 Headphones\n"

# aplay as gettext translates it: French when the locale it runs under
# (LC_ALL, else LC_MESSAGES, else LANG) is, English otherwise.
APLAY_FR = """#!/bin/sh
echo "aplay $*" >> /fppinit-calls.log
[ "$1" = -l ] || exit 0
case "${LC_ALL:-${LC_MESSAGES:-$LANG}}" in
fr*) echo "**** Liste des Périphériques Matériels PLAYBACK ****"
     echo "carte 0 : Headphones [bcm2835 Headphones], périphérique 0 : bcm2835 Headphones [bcm2835 Headphones]" ;;
*)   echo "**** List of PLAYBACK Hardware Devices ****"
     echo "card 0: Headphones [bcm2835 Headphones], device 0: bcm2835 Headphones [bcm2835 Headphones]" ;;
esac
echo "  Subdevices: 8/8"
"""


def test_a_french_system_still_finds_its_sound_card(fppinit):
    """fppinit started under a French locale -- as systemd starts it on a
    stock Debian set up in French, where aplay -l lists "carte 0 :" --
    still finds the board's one sound card: it takes it for AudioOutput
    and never stands snd-dummy in for it.

    Regression: 086fd576d (fppinit's half). fppinit ran aplay under the
    system locale and looked for lines starting "card", so on such a
    system its audio setup found no sound card at all. Not covered: the
    web UI's card lists, which now read /proc/asound (the web container
    has none)."""
    maps = fake_boards(fppinit, cards=JACK)
    fppinit.root_file("/usr/bin/aplay", APLAY_FR)
    fppinit.stub_output("amixer", "scontrols", "Simple mixer control 'PCM',0\n")
    out, _ = setup_audio(fppinit, maps, env=("LANG=fr_FR.UTF-8", "LC_ALL=fr_FR.UTF-8"))
    assert "aplay -l" in fppinit.calls(), f"precondition: aplay -l never ran:\n{out[-3000:]}"
    assert not any("snd-dummy" in m or "snd_dummy" in m for m in modprobes(fppinit)), (modprobes(fppinit), out[-3000:])
    selected = [l for l in open(os.path.join(fppinit.media, "settings")).read().splitlines()
                if l.split("=", 1)[0].strip() == "AudioOutput"]
    assert selected == ['AudioOutput = "Headphones"'], (selected, out[-3000:])


SINKS_CONF = "/etc/pipewire/pipewire.conf.d/95-fpp-alsa-sink.conf"
DAC8X = " 0 [sndrpihifiberry]: RPi-simple - snd_rpi_hifiberry_dac8x\n                      snd_rpi_hifiberry_dac8x\n"
DAC8X_APLAY = ("**** List of PLAYBACK Hardware Devices ****\n"
               "card 0: sndrpihifiberry [snd_rpi_hifiberry_dac8x], device 0: HifiBerry DAC8x HiFi multicodec-0 "
               "[HifiBerry DAC8x HiFi multicodec-0]\n  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n")


def dac8x_channels(conf):
    import re
    m = re.search(r'node\.name = "fpp_alsa_sndrpihifiberry"[\s\S]*?audio\.channels = (\d+)', conf or "")
    return int(m.group(1)) if m else None


def test_an_eight_channel_i2s_dac_gets_all_its_channels(fppinit):
    """A HiFiBerry DAC8x -- four stereo DACs on one I2S bus, whose driver
    advertises a channel range, CHANNELS: [2 8] -- gets an 8-channel ALSA
    adapter in 95-fpp-alsa-sink.conf. A cached conf that pinned it at 2
    (written before this) is noticed on the next boot, though it covers
    every card, and rewritten at 8.

    Regression: b8229a78b (the channel quirk). A range on a non-USB card is
    read as stereo, since the Pi's headphone jack advertises [1 8] too, so
    the DAC8x's adapter was 2 channels and six of its outputs were never
    reachable (issue #2620). Not covered: the PHP mirror
    (DetectAlsaCardMaxChannels()), the systemd unit refresh, the linking
    hook install and the restart of a PipeWire that isn't running."""
    from setupaudio import APLAY, dump
    from test_fppinit_audio_cards import set_setting
    maps = fake_boards(fppinit, cards=DAC8X)
    fppinit.root_file("/.dockerenv", None)
    fppinit.root_file("/usr/bin/aplay", APLAY)
    fppinit.stub_output("aplay", "-l", DAC8X_APLAY)
    fppinit.stub_output("aplay", "hw:sndrpihifiberry", dump("sndrpihifiberry", formats="S16_LE S32_LE", channels="[2 8]"))
    fppinit.stub_output("amixer", "scontrols", "Simple mixer control 'PCM',0\n")
    fppinit.stub_output("pactl", "list", "1\tfpp_alsa_sndrpihifiberry\tPipeWire\ts16le 8ch 44100Hz\tSUSPENDED\n")
    set_setting(fppinit, AudioOutput="sndrpihifiberry", MediaBackend="pipewire-simple")
    out, _ = setup_audio(fppinit, maps)
    sinks = fppinit.written(SINKS_CONF)
    assert dac8x_channels(sinks) == 8, f"the DAC8x's adapter:\n{sinks}\n{out[-3000:]}"

    fppinit.root_file(SINKS_CONF, sinks.replace("audio.channels = 8", "audio.channels = 2"))
    out, _ = setup_audio(fppinit, maps)
    rewritten = fppinit.written(SINKS_CONF)
    assert dac8x_channels(rewritten) == 8, f"a cached 2-channel adapter after a boot:\n{rewritten}\n{out[-3000:]}"


def test_a_boot_points_pipewires_default_sink_at_fppds(fppinit):
    """A boot of a Simple-mode board whose PipeWire default sink is some
    other sink (what WirePlumber remembered, or the first adapter on a
    first boot): setupAudio makes the sink fppd plays to (PipeWireSinkName)
    the default, through pactl. With that sink not in the graph, the
    default is left as it is.

    Regression: c7a2fca4a. Only the UI's applies set the default sink, so
    a boot left the remembered or first-come one: a plugin's player, or
    anything else naming no target, played out of another card."""
    maps = no_card_box(fppinit)
    set_setting(fppinit, PipeWireSinkName="fpp_group_default")
    fppinit.stub_output("pactl", "get-default-sink", "fpp_alsa_other\n")
    out, _ = setup_audio(fppinit, maps)
    sets = [c for c in fppinit.calls() if c.startswith("pactl set-default-sink")]
    assert sets == ["pactl set-default-sink fpp_group_default"], f"{sets}\n{out[-3000:]}"

    # The control: fppd's sink isn't in the graph, so the default stays.
    fppinit.stub_output("pactl", "list", "1\tfpp_group_other\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n")
    set_setting(fppinit, PipeWireSinkName="fpp_group_default")
    out, _ = setup_audio(fppinit, maps)
    sets = [c for c in fppinit.calls() if c.startswith("pactl set-default-sink")]
    assert sets == [], f"{sets}\n{out[-3000:]}"
