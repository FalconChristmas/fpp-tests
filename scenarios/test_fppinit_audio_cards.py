"""setupAudio against a real sound card: when fppinit regenerates the
PipeWire audio config and when it leaves it alone.

Each check is about a config that names a card that is present, so it
needs one: the sandbox (fppinit.py) sees the host's /proc/asound, and the
card's aplay listing and hardware parameters are handed to the stubbed
aplay from there. Nothing reaches the card or the device's PipeWire --
systemctl, pactl and aplay are stubs, and /etc is the sandbox's overlay.
Skipped where there is no sound card (Docker); run with run-local.sh on a
device that has one (verified on a Pi 4's headphone jack).

Every sandbox run starts from the real /etc again, so each scenario first
lets setupAudio write a clean config for the card ("prime"), then plants
the files that run wrote -- as a box carries them from one boot to the
next -- with the change under test.
"""

import json
import os
import re

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

CONF = "/etc/pipewire/pipewire.conf.d/"
SINKS = CONF + "95-fpp-alsa-sink.conf"
GROUPS = CONF + "97-fpp-audio-groups.conf"
RULES = "/etc/wireplumber/wireplumber.conf.d/50-fpp-suppress-alsa-dupes.conf"
# What a box carries between runs, besides the media directory.
CARRIED = (SINKS, GROUPS, RULES)


def cards():
    """[(index, id, name)] from /proc/asound/cards."""
    out = []
    try:
        with open("/proc/asound/cards") as f:
            for line in f:
                m = re.match(r"^\s*(\d+) \[(\S+)\s*\]: \S+ - (.*)$", line)
                if m:
                    out.append((int(m.group(1)), m.group(2), m.group(3).strip()))
    except OSError:
        pass
    return out


def pcm_names():
    """{card index: playback PCM name} from /proc/asound/pcm."""
    names = {}
    try:
        with open("/proc/asound/pcm") as f:
            for line in f:
                m = re.match(r"^(\d+)-00: ([^:]+?) : .*playback", line)
                if m:
                    names[int(m.group(1))] = m.group(2)
    except OSError:
        pass
    return names


def real_card():
    """The first card that is real hardware and not HDMI (whose audio
    setupAudio drops with no display connected)."""
    for idx, cid, name in cards():
        if cid in ("Dummy", "Loopback") or "hdmi" in (cid + name).lower():
            continue
        return idx, cid, name
    return None


CARD = real_card()
needs_card = pytest.mark.skipif(CARD is None, reason="needs a real, non-HDMI sound card (run-local.sh on a device)")


def node(cid):
    """normalizeCardIdForNode(): lower case, anything else an underscore."""
    return re.sub(r"[^a-z0-9_]", "_", cid.lower())


def set_setting(sb, **kv):
    """Set settings in place (settings() appends, and a key must be there once)."""
    path = os.path.join(sb.media, "settings")
    lines = open(path).read().splitlines() if os.path.exists(path) else []
    lines = [l for l in lines if l.split("=", 1)[0].strip() not in kv]
    lines += [f'{k} = "{v}"' for k, v in kv.items()]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def as_a_box(sb, backend):
    """The selected card, the stubs' answers for it, and none of the
    device's own PipeWire config: the first run probes from scratch."""
    idx, cid, name = CARD
    set_setting(sb, MediaBackend=backend, AudioOutput=cid)
    pcms = pcm_names()
    listing = "**** List of PLAYBACK Hardware Devices ****\n" + "".join(
        f"card {i}: {c} [{n}], device 0: {pcms.get(i, n)} [{pcms.get(i, n)}]\n"
        f"  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n"
        for i, c, n in cards() if i in pcms)
    sb.stub_output("aplay", "-l", listing)
    sb.stub_output("aplay", f"hw:{cid}", f'HW Params of device "hw:{cid}":\n--------------------\n'
                   "ACCESS:  MMAP_INTERLEAVED RW_INTERLEAVED\nFORMAT:  S16_LE\nSUBFORMAT:  STD\n"
                   "SAMPLE_BITS: 16\nFRAME_BITS: 32\nCHANNELS: 2\nRATE: [8000 192000]\n"
                   "PERIOD_SIZE: [80 131072]\nBUFFER_SIZE: [80 131072]\n--------------------\n")
    sb.stub_output("amixer", "scontrols", "Simple mixer control 'PCM',0\n")
    # The stack's sinks come up, so setupAudio doesn't wait 30 s for them and
    # then discard the config to start over.
    sb.stub_output("pactl", "list", f"1\tfpp_alsa_{node(cid)}\tPipeWire\ts16le 2ch 44100Hz\tSUSPENDED\n")
    for path in CARRIED + (CONF + "96-fpp-input-groups.conf", CONF + "94-fpp-vban.conf"):
        sb.root_file(path, None)
    return cid, node(cid)


def run(sb, media_home=False):
    """One setupAudio. media_home: the media directory is /home/fpp/media
    too, where the regeneration PHP reads its settings."""
    r = sb._run(["/opt/fpp/src/fppinit", "setupAudio"], timeout=240, media_home=media_home)
    out = r.stdout + r.stderr
    assert "terminate called" not in out and "AddressSanitizer" not in out, out[-3000:]
    assert r.returncode == 0, f"fppinit exited {r.returncode}:\n{out[-3000:]}"
    return out


def carry(sb):
    """Plant what the last run left in /etc for the next run, as a reboot does."""
    for path in CARRIED:
        content = sb.written(path)
        if content is not None:
            sb.root_file(path, content)


def prime(sb, backend="pipewire-simple"):
    cid, n = as_a_box(sb, backend)
    out = run(sb)
    sinks = sb.written(SINKS) or ""
    assert f'node.name = "fpp_alsa_{n}"' in sinks, \
        f"precondition: the first run gave {cid} no adapter in 95:\n{sinks}\n{out[-3000:]}"
    carry(sb)
    return cid, n, out


@needs_card
def test_a_simple_config_aimed_at_wireplumbers_node_is_regenerated(fppinit):
    """Simple mode, a card FPP owns (it has an fpp_alsa_ adapter in 95), and
    a 97 conf whose filter-chain plays into WirePlumber's alsa_output node
    for it -- a card selected while it was hot-plugged: setupAudio
    regenerates the conf onto fpp_alsa_<card>, and the next run accepts it.

    Regression: 3ac940c4a. Nothing checked where the conf pointed: the card
    was present and selected, and the Simple JSON carries no nodeTarget, so
    the conf was accepted every boot while WirePlumber's node, suppressed
    for an owned card, never came back: the chain's output stayed unlinked
    and the card silent."""
    cid, n, _ = prime(fppinit)
    good = fppinit.written(GROUPS)
    target = f'node.target = "fpp_alsa_{n}"'
    assert good and target in good, f"precondition: the clean Simple conf targets the adapter:\n{good}"
    bad = good.replace(target, f'node.target = "alsa_output.platform-{n}.stereo-fallback"')
    fppinit.root_file(GROUPS, bad)
    fppinit.write("config/pipewire-audio-groups.conf", bad)  # the cache matches, as on a box

    out = run(fppinit)
    assert f"Simple audio config does not target FPP's adapter for {cid}; regenerating" in out, out[-3000:]
    assert target in fppinit.written(GROUPS), fppinit.written(GROUPS)
    assert target in fppinit.media_file("config/pipewire-audio-groups.conf")

    carry(fppinit)
    out = run(fppinit)
    assert "does not target FPP's adapter" not in out, "the regenerated conf was regenerated again"
    assert "skipping regeneration" in out, out[-3000:]


@needs_card
def test_a_simple_config_duplicating_the_boot_adapter_is_regenerated(fppinit):
    """Simple mode, and a 97 conf that declares the selected card's
    fpp_alsa_ adapter itself while 95 already declares it at boot:
    setupAudio regenerates 97 without the second adapter.

    Regression: 4b49ca1ea. Two adapters on one PCM under one node.name: the
    second open of the PCM fails EBUSY, its node errors, and a stream that
    lands on it blocks forever. Every other check asks whether the card
    changed, and it hadn't."""
    cid, n, _ = prime(fppinit)
    good = fppinit.written(GROUPS)
    dup = (f'context.objects = [\n  {{ factory = adapter\n    args = {{\n'
           f'      factory.name = api.alsa.pcm.sink\n      node.name = "fpp_alsa_{n}"\n'
           f'      media.class = "Audio/Sink"\n      api.alsa.path = "hw:{cid}"\n    }}\n  }}\n]\n')
    fppinit.root_file(GROUPS, dup + good)
    fppinit.write("config/pipewire-audio-groups.conf", dup + good)

    out = run(fppinit)
    assert f"Simple audio config duplicates the boot ALSA adapter for {cid}; regenerating" in out, out[-3000:]
    assert f'node.name = "fpp_alsa_{n}"' not in fppinit.written(GROUPS), fppinit.written(GROUPS)


@needs_card
def test_a_group_member_cached_on_wireplumbers_node_is_regenerated(fppinit):
    """Advanced mode, a card FPP owns, and an output group member whose
    cached nodeTarget is WirePlumber's alsa_output name for it: setupAudio
    does not accept the cached conf but runs the regeneration. The same
    config with the member on fpp_alsa_<card> is accepted (the control).

    Regression: c1bb01ad3. Boot validation only checked that the member's
    card was present -- it was -- so the conf built from the cached name was
    re-accepted on every boot, linked to a node that never exists for an
    owned card, and played silently."""
    idx, cid, name = CARD
    n = node(cid)
    groups = {"groups": [{"id": 1, "name": "Main", "enabled": True, "channels": 2, "volume": 100,
                          "members": [{"cardId": cid, "channels": 2, "delayMs": 0, "volume": 100}]}]}
    fppinit.write("config/pipewire-audio-groups.json", groups)
    prime(fppinit, backend="pipewire")
    # A conf both copies agree on, so only the member's target can decide.
    conf = ("# Auto-generated by FPP - PipeWire Audio Output Groups\n"
            "context.modules = [\n  { name = libpipewire-module-combine-stream\n"
            "    args = { node.name = \"fpp_group_main\" stream.props = { node.passive = true } } }\n]\n")
    fppinit.root_file(GROUPS, conf)
    fppinit.write("config/pipewire-audio-groups.conf", conf)

    def with_target(target):
        groups["groups"][0]["members"][0]["nodeTarget"] = target
        fppinit.write("config/pipewire-audio-groups.json", groups)
        fppinit.write("config/pipewire-audio-groups.conf", conf)
        return run(fppinit, media_home=True)

    out = with_target(f"fpp_alsa_{n}")
    assert "all referenced cards present; skipping regeneration" in out, \
        f"control: a member on FPP's adapter is accepted\n{out[-3000:]}"
    wp = f"alsa_output.platform-{n}.stereo-fallback"
    out = with_target(wp)
    assert f"PipeWire audio group targets {wp}, which FPP's own adapter replaces; regenerating" in out, out[-3000:]
    assert "skipping regeneration" not in out, out[-3000:]
    assert "Validating PipeWire audio group config against current hardware" in out, out[-3000:]


@needs_card
def test_a_new_period_size_rewrites_the_alsa_adapters(fppinit):
    """AudioPeriodSize changed with the same card present: setupAudio
    rewrites 95 with the new api.alsa.period-size (and records it), and the
    run after that keeps it.

    Regression: f5d0581d1. Nothing in 95 recorded the period size it was
    written with, so the conf still matched the cards and every boot logged
    "skipping probe": the setting read as applied while PipeWire kept the
    old period."""
    set_setting(fppinit, AudioPeriodSize="256")
    cid, n, _ = prime(fppinit)
    assert "api.alsa.period-size = 256" in fppinit.written(SINKS), fppinit.written(SINKS)

    set_setting(fppinit, AudioPeriodSize="1024")
    out = run(fppinit)
    assert "configured period size is now 1024; regenerating" in out, out[-3000:]
    sinks = fppinit.written(SINKS)
    assert "api.alsa.period-size = 1024" in sinks and "api.alsa.period-size = 256" not in sinks, sinks

    carry(fppinit)
    out = run(fppinit)
    assert "ALSA sink adapters already match present cards; skipping probe" in out, out[-3000:]
