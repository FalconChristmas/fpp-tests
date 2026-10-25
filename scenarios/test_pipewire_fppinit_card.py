"""setupAudio against a real sound card (see test_fppinit_audio_cards.py for
how the sandbox is set up as a box): the PCM format chosen for a card that
does not take S16, and the mix bus levels restored after the stack starts.

Skipped where there is no sound card (Docker); run with run-local.sh on a
device that has one (verified on a Pi 4's headphone jack).
"""

import json

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit_audio_cards import SINKS, as_a_box, needs_card, run

# aplay as the sandbox's stub (fppinit.py) runs it -- log the call, print
# what the scenario gave for its first argument that has an answer -- except
# that playing S16_LE fails, as on a card that takes only 32-bit samples.
APLAY_NO_S16 = r"""#!/bin/sh
printf '%s\n' "aplay $*" >> /fppinit-calls.log
prev=
for a in "$@"; do
    if [ "$prev" = "-f" ] && [ "$a" = "S16_LE" ]; then
        echo "aplay: set_params:1352: Sample format non available" >&2
        exit 1
    fi
    prev=$a
done
for a in "$@"; do
    f="/fppinit-state/aplay.$a.out"
    if [ -f "$f" ]; then cat "$f"; break; fi
done
exit 0
"""


@needs_card
def test_a_card_without_s16_gets_a_format_it_takes(fppinit):
    """A card that advertises only S32_LE, and refuses S16_LE when asked:
    its PipeWire adapter in 95-fpp-alsa-sink.conf is S32LE.

    Regression: 957ff35f1. The format probe measured every wider format
    against S16LE's rate, and S16LE was assumed to work on every card: on
    one without it the baseline probe failed, the probe declined to widen,
    and the adapter was written as S16LE, which the card refuses -- no
    audio at all."""
    cid, n = as_a_box(fppinit, "pipewire-simple")
    fppinit.stub_output("aplay", f"hw:{cid}", f'HW Params of device "hw:{cid}":\n--------------------\n'
                        "ACCESS:  MMAP_INTERLEAVED RW_INTERLEAVED\nFORMAT:  S32_LE\nSUBFORMAT:  STD\n"
                        "SAMPLE_BITS: 32\nFRAME_BITS: 64\nCHANNELS: 2\nRATE: [8000 192000]\n"
                        "PERIOD_SIZE: [80 131072]\nBUFFER_SIZE: [80 131072]\n--------------------\n")
    fppinit.root_file("/usr/bin/aplay", APLAY_NO_S16)
    out = run(fppinit)
    sinks = fppinit.written(SINKS) or ""
    assert f'node.name = "fpp_alsa_{n}"' in sinks, f"no adapter for {cid}:\n{sinks}\n{out[-3000:]}"
    assert 'audio.format = "S32LE"' in sinks, f"the S32-only card's adapter:\n{sinks}"
    assert any("-f S32_LE" in c for c in fppinit.calls() if c.startswith("aplay")), \
        "the card was never probed in S32_LE, so this proves nothing"


@needs_card
def test_mix_bus_levels_are_restored_after_the_stack_starts(fppinit):
    """Advanced mode, an output group on the card and an enabled input group
    saved at 40% and muted: once setupAudio has brought the stack up it
    sets the mix bus sink (fpp_input_<name>) back to 40% and muted, as it
    does the output groups' levels.

    Regression: da73dbec6. Only output group and member levels were
    restored (and not even those without an output groups file). PipeWire
    rebuilds the mix buses at full volume on every start, so a bus fader
    lasted only until the next reboot.

    The precondition guards 84a42ddac: setupAudio restored no output group
    levels at all, so WirePlumber's remembered ones stood."""
    cid, n = as_a_box(fppinit, "pipewire")
    fppinit.write("config/pipewire-audio-groups.json", {"groups": [
        {"id": 1, "name": "Main", "enabled": True, "channels": 2, "volume": 100,
         "members": [{"cardId": cid, "channels": 2, "delayMs": 0, "volume": 100}]}]})
    fppinit.write("config/pipewire-input-groups.json", {"inputGroups": [
        {"id": 1, "name": "Bus", "enabled": True, "channels": 2, "volume": 40, "mute": True,
         "outputs": [1], "members": []}]})
    out = run(fppinit, media_home=True)
    calls = [c for c in fppinit.calls() if c.startswith("pactl set-sink")]
    assert any("fpp_group_main" in c for c in calls), \
        f"precondition: the output groups' levels were restored: {calls}\n{out[-3000:]}"
    assert "pactl set-sink-volume fpp_input_bus 40%" in calls, f"{calls}\n{out[-3000:]}"
    assert "pactl set-sink-mute fpp_input_bus 1" in calls, calls


def _node(nid, name, target=None, volumes=(1.0, 1.0)):
    """A node as pw-dump lists it: name, connection target, channel volumes."""
    props = {"node.name": name}
    if target:
        props["node.target"] = target
    return {"id": nid, "type": "PipeWire:Interface:Node",
            "info": {"props": props, "params": {"Props": [{"channelVolumes": list(volumes)}]}}}


@needs_card
def test_member_and_routing_path_levels_are_restored_after_the_stack_starts(fppinit):
    """Advanced mode, an output group on the card and two mix buses that
    fppd_stream_1 feeds -- so it reaches each through a loopback -- one with
    the member saved at 50% and a routing path to the output group at 60%:
    once setupAudio has brought the stack up it sets the member's loopback
    and the path's stream to those levels, on the nodes pw-dump names, with
    pw-cli as the faders do.  A member and a path left at 100% are set too
    (WirePlumber puts back a stream's last live level), and a muted member
    is left alone.

    Regression: fpp 38827a39d. The generated config gives these levels as
    channelmix.volume, which PipeWire keeps as a property and does not
    apply, and the restore here set only the bus and output group levels,
    so both were heard at 100% after every boot.

    The pw-cli call is the one www/api's RestorePipeWireInputGroupVolumes()
    makes, which web/tests/pw-saved-levels-after-restart.spec.ts measures
    through a real PipeWire."""
    cid, n = as_a_box(fppinit, "pipewire")
    fppinit.write("config/pipewire-audio-groups.json", {"groups": [
        {"id": 1, "name": "Main", "enabled": True, "channels": 2, "volume": 100,
         "members": [{"cardId": cid, "channels": 2, "delayMs": 0, "volume": 100}]}]})
    fppinit.write("config/pipewire-input-groups.json", {"inputGroups": [
        {"id": 1, "name": "Bus A", "enabled": True, "channels": 2, "volume": 80, "outputs": [1],
         "routing": {"1": {"volume": 60, "mute": False}},
         "members": [{"type": "fppd_stream", "sourceId": "fppd_stream_1", "volume": 50},
                     {"type": "capture", "name": "Line In", "cardId": cid, "mute": True}]},
        {"id": 2, "name": "Bus B", "enabled": True, "channels": 2, "volume": 100, "outputs": [1],
         "members": [{"type": "fppd_stream", "sourceId": "fppd_stream_1"}]}]})
    fppinit.stub_output("pw-dump", "", json.dumps([
        {"id": 30, "type": "PipeWire:Interface:Core", "info": {}},
        _node(41, "output.fpp_loopback_ig1_fppd_stream_1", "fpp_input_bus_a"),
        _node(42, "input.fpp_loopback_ig1_fppd_stream_1", "fpp_tee_fppd_stream_1"),
        _node(43, "output.fpp_loopback_ig2_fppd_stream_1", "fpp_input_bus_b"),
        _node(44, "output.fpp_loopback_ig1_line_in", "fpp_input_bus_a"),
        _node(51, "output.fpp_input_bus_a_fpp_group_main", "fpp_group_main"),
        _node(52, "output.fpp_input_bus_b_fpp_group_main", "fpp_group_main", (1.0, 1.0, 1.0, 1.0)),
        _node(60, "fpp_input_bus_a"),
    ]))
    out = run(fppinit, media_home=True)
    calls = fppinit.calls()
    assert "pactl set-sink-volume fpp_input_bus_a 80%" in calls, \
        f"precondition: the bus levels were restored: {[c for c in calls if c.startswith('pactl')]}\n{out[-3000:]}"
    sets = sorted(c for c in calls if c.startswith("pw-cli set-param"))
    assert sets == sorted([
        "pw-cli set-param 41 Props { channelVolumes: [ 0.5, 0.5 ] }",
        "pw-cli set-param 43 Props { channelVolumes: [ 1, 1 ] }",
        "pw-cli set-param 51 Props { channelVolumes: [ 0.6, 0.6 ] }",
        "pw-cli set-param 52 Props { channelVolumes: [ 1, 1, 1, 1 ] }",
    ]), f"{sets}\n{out[-3000:]}"
