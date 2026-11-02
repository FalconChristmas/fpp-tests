"""scripts/pipewire_diagnostics.sh on a player with no sound card selected, and
on one in simple mode: the graph section's null group sink and the ALSA
section's card lines. The helpers (the fppinit sandbox, the stand-in pw-dump
graph) are test_pipewire_diagnostics_checks.py's."""

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_pipewire_diagnostics_checks import diag, graph, node, link

NULL_SINK = {"factory.name": "support.null-audio-sink"}


def test_a_null_group_sink_is_the_end_of_its_chain_not_a_sink_feeding_nothing(fppinit):
    """With no sound card selected fppd builds fpp_group_default as a null
    sink, which nothing is linked out of. The graph section says so, passes,
    and does not warn that it feeds nothing; a group sink that is not a null
    sink and has no link still warns, in the same graph.

    Regression: 795efc47a. The warning "These FPP sinks feed nothing (fine if
    unused, silent if not)" named fpp_group_default on every player that had
    no card, which is what a player with nothing to play to looks like."""
    null = [node(10, "fpp_group_default", **NULL_SINK)]
    out = graph(fppinit, null)
    assert "[INFO] No sound card is configured, so these sinks are null sinks:" in out, out[-3000:]
    listed = out.split("so these sinks are null sinks:", 1)[1].split("[PASS]", 1)[0]
    assert "fpp_group_default" in listed, out[-3000:]
    assert "[PASS] Every FPP group sink is linked out or is a null sink" in out, out[-3000:]
    assert "These FPP sinks feed nothing" not in out, out[-3000:]

    # The control: an unlinked sink that is not a null sink is still a fault.
    out = graph(fppinit, null + [node(20, "fpp_group_lonely")])
    assert "[WARN] These FPP sinks feed nothing" in out, out[-3000:]
    listed = out.split("These FPP sinks feed nothing", 1)[1].split("---", 1)[0]
    assert "fpp_group_lonely" in listed and "fpp_group_default" not in listed, out[-3000:]
    assert "[PASS] Every FPP group sink" not in out, out[-3000:]

    # And a linked sink is untouched: no null-sink notice, the usual pass.
    healthy = [node(30, "fpp_group_main"), node(31, "output.fpp_group_main_fpp_fx_g1_s3", "Stream/Output/Audio"),
               node(32, "fpp_fx_g1_s3"), link(50, 31, 32)]
    out = graph(fppinit, healthy)
    assert "[PASS] Every FPP group sink has at least one outgoing link" in out, out[-3000:]
    assert "null sinks" not in out, out[-3000:]


def test_the_alsa_section_reads_the_group_file_of_the_mode_the_player_is_in(fppinit):
    """A player whose MediaBackend was never written is in simple mode, and
    the ALSA section checks the cards its simple-mode groups name; the
    leftover advanced-mode file is not read. The simple-mode file records only
    the card id, so a missing card is named without an empty "()" after it;
    in advanced mode, whose file has the card's friendly name, the name is
    shown.

    Regression: 795efc47a. The section compared MediaBackend to
    "pipewire-simple" itself, so an unset one took the advanced file, which
    still named the member cards of whatever was set up before, and reported
    them missing; and the missing-card lines read "card S3 ()"."""
    fppinit.write("config/pipewire-audio-groups-simple.json",
                  {"groups": [{"name": "Main", "members": [{"cardId": "S3", "channels": 2}]}]})
    fppinit.write("config/pipewire-audio-groups.json",
                  {"groups": [{"name": "Old Output", "members": [{"cardId": "Dummy", "cardName": "Dummy Out", "channels": 2}]}]})

    for backend in ("", "pipewire-simple"):
        fppinit.write("settings", f'MediaBackend = "{backend}"\n' if backend else "")
        out = diag(fppinit, "alsa", cards=[("Other", "Other")])
        assert "[FAIL] 'Main' member card S3 is NOT present" in out, f"{backend!r}: {out[-3000:]}"
        assert "S3 ()" not in out, f"{backend!r}: {out[-3000:]}"
        assert "Old Output" not in out and "member card Dummy" not in out, f"{backend!r}: {out[-3000:]}"

    fppinit.write("settings", 'MediaBackend = "pipewire"\n')
    out = diag(fppinit, "alsa", cards=[("Other", "Other")])
    assert "[FAIL] 'Old Output' member card Dummy (Dummy Out) is NOT present" in out, out[-3000:]
    assert "'Main'" not in out, out[-3000:]
