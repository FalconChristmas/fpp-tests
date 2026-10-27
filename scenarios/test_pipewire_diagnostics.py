"""scripts/pipewire_diagnostics.sh, the Troubleshooting page's PipeWire
health checks: run as root in the fppinit sandbox (fppinit.py) so nothing
it does reaches the machine, or against the scenario's own PipeWire (the
audio fixture) for the checks that read the running graph."""

import os

from fppinit import fppinit  # noqa: F401 -- the fixture


def test_a_temp_dir_it_cannot_make_does_not_cost_tmp(fppinit):
    """When the diagnostics can't make their temp directory (here /tmp has
    no inodes left), they fail with a message and leave /tmp alone.

    Regression: 475eb920b. A failed mktemp fell back to /tmp itself as the
    temp directory, and the exit trap ran rm -rf on it: every file in /tmp
    went, as root."""
    # The sandbox's mount is a stub that records its calls, so /tmp is
    # remounted through libc.
    script = r"""
python3 -c 'import ctypes, sys; sys.exit(ctypes.CDLL(None, use_errno=True).mount(b"tmpfs", b"/tmp", b"tmpfs", 0, b"size=1m,nr_inodes=3"))' || exit 90
touch /tmp/keep || exit 91
i=0
while touch /tmp/fill$i 2>/dev/null; do
    i=$((i + 1)); [ $i -gt 50 ] && exit 92
done
mkdir /tmp/probe 2>/dev/null && exit 93
/opt/fpp/scripts/pipewire_diagnostics.sh no-such-section
echo "diagnostics exited $?"
ls /tmp
"""
    r = fppinit._run(["sh", "-c", script], timeout=60)
    out = r.stdout + r.stderr
    assert r.returncode == 0, f"could not fill /tmp (setup step {r.returncode}):\n{out[-2000:]}"
    assert "diagnostics exited" in out, out[-2000:]
    listing = out.split("diagnostics exited", 1)[1].split()
    assert "keep" in listing, f"the diagnostics emptied /tmp:\n{out[-2000:]}"
    assert "cannot create temp directory" in out, out[-2000:]


def test_a_configured_default_sink_that_is_gone_is_reported(fppd, audio):
    """The graph section says when WirePlumber's configured default sink
    (default.configured.audio.sink, the sticky "set default") names a node
    that is not in the graph, and which sink the graph uses instead; one
    that exists passes (the control). Against the scenario's own PipeWire
    and WirePlumber, which is where the script looks (/run/pipewire-fpp).

    Feature: 4b49ca1ea, the diagnostics half. A backend mode switch deletes
    the group sinks of the mode it leaves, the configured default stays on
    one of them, and nothing complained until a node of that name came back
    and silently took the default."""
    import shutil
    import subprocess
    from audio import SINK, env

    # The script points clients at /etc/pipewire, which on a device always
    # has client.conf (FPP_Install.sh, and fppinit's setupAudio, copy it
    # there); the container has none.
    conf = "/etc/pipewire/client.conf"
    made = not os.path.exists(conf)
    if made:
        os.makedirs(os.path.dirname(conf), exist_ok=True)
        shutil.copy("/usr/share/pipewire/client.conf", conf)

    def sh(cmd):
        r = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, env=env(), timeout=60)
        return r.stdout + r.stderr

    def configured(name):
        sh(f"pw-metadata -n default 0 default.configured.audio.sink '{{\"name\":\"{name}\"}}' Spa:String:JSON")
        got = sh("pw-metadata -n default")
        assert f"key:'default.configured.audio.sink' value:'{{\"name\":\"{name}\"}}'" in got, got
        return sh(f"bash {fppd.tree}/scripts/pipewire_diagnostics.sh graph")

    fppd.start()
    try:
        out = configured("fpp_gone_sink")
        assert "Could not read the graph" not in out, out
        assert "[WARN] The configured default sink 'fpp_gone_sink' does not exist in the graph" in out, out
        assert f"The graph is using {SINK}" in out, out

        out = configured(SINK)
        assert f"[PASS] The configured default sink ({SINK}) exists" in out, out
        assert "does not exist in the graph" not in out, out
    finally:
        sh("pw-metadata -n default -d 0 default.configured.audio.sink")
        if made:
            os.remove(conf)


def test_xruns_off_the_card_are_described_by_how_long_their_nodes_live(fppinit):
    """Xruns pw-top counts on nodes other than the card are listed as group,
    stream and client xruns, with notes saying FPP's group and effects nodes
    live until PipeWire restarts (so their counts compare between runs) and
    that a climbing count in the playback path can leave the sound behind the
    lights. pw-top is a stand-in printing two snapshots with xruns on a group
    node, fppd's stream and a probe.

    Regression: a0b4c6a00. The notes called every such count "context, not a
    fault", said fppd_stream_N and the other client nodes were rebuilt per
    track so the numbers were not a trend -- no longer true, and the reason a
    climbing count on a group node or the held-open stream was dismissed."""
    script = r"""
cat > /usr/bin/pw-top <<'STUB'
#!/bin/sh
for pass in 1 2; do
echo "S   ID  QUANT   RATE    WAIT    BUSY   W/Q   B/Q  ERR FORMAT           NAME"
echo "R   40   1024  48000  12.0us  30.0us  0.00  0.00    0    S16LE 2 48000 fpp_alsa_card0"
echo "R   52   1024  48000  12.0us  30.0us  0.00  0.00    7    F32LE 2 48000 fpp_group_Main"
echo "R   61   1024  48000  12.0us  30.0us  0.00  0.00    3    F32LE 2 48000 fppd_stream_1"
echo "R   70   1024  48000  12.0us  30.0us  0.00  0.00    1    F32LE 2 48000 gst-launch-1.0"
done
STUB
chmod +x /usr/bin/pw-top
/opt/fpp/scripts/pipewire_diagnostics.sh performance
"""
    r = fppinit._run(["sh", "-c", script], timeout=120)
    out = r.stdout + r.stderr
    assert "11 xrun(s) on group, stream and client nodes" in out, out[-3000:]
    assert "context, not a fault" not in out, out[-3000:]
    assert "rebuilt per track" not in out, out[-3000:]
    notes = " ".join(l.strip() for l in out.splitlines())  # the notes wrap over lines
    assert "fpp_group_* and fpp_fx_* nodes live until the PipeWire services restart" in notes, out[-3000:]
    assert "can leave the sound behind the lights" in notes, out[-3000:]
