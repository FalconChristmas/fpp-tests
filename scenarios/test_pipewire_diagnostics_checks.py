"""More of scripts/pipewire_diagnostics.sh, the Troubleshooting page's
PipeWire health checks: the ALSA contention and probe checks, the config
and graph checks, and the network, RTSP, performance and smoke sections.
Each runs as root in the fppinit sandbox (fppinit.py) with the commands the
section reads stubbed to print what a device would, so nothing reaches the
machine; test_pipewire_diagnostics.py has the others."""

import json
import os
import shutil
import subprocess
import time

import pytest

import shims
from fppinit import fppinit  # noqa: F401 -- the fixture

MEDIA = "/fpp-test-media"
CARDS = ("{id:>2} [{name:<15}]: {driver} - {name}\n                      {name}\n")


def diag(sb, section, pre="", cards=None, timeout=120, sh="bash"):
    """Run `pipewire_diagnostics.sh <section>` in the sandbox, after the shell
    commands in `pre`; returns its output. `cards` is [(id, driver)] for the
    sound cards /proc/asound/cards lists, which Docker's kernel has none of:
    fakesys.so serves a directory of the scenario's from there. The media
    directory is /home/fpp/media, which the script's common file takes from
    the tree's media_root.txt."""
    env = ""
    if cards is not None:
        so = os.path.join(sb.media, "fakesys.so")
        shutil.copy(shims.build("fakesys.c"), so)
        sb.root_file("/fake-asound/cards", "".join(
            CARDS.format(id=i, name=name, driver=driver) for i, (name, driver) in enumerate(cards))
            or "--- no soundcards ---\n")
        env = f"LD_PRELOAD={MEDIA}/fakesys.so FAKESYS=/proc/asound=/fake-asound "
    # The trailing exit keeps bash from running the script in the shell's own
    # process, which would make the processes `pre` starts its children.
    script = f"{pre}\n{env}{sh} /opt/fpp/scripts/pipewire_diagnostics.sh {section}\nexit $?\n"
    try:
        r = sb._run(["bash", "-c", script], timeout=timeout, media_home=True)
    except Exception as e:  # noqa: BLE001 -- a hung script is the finding
        pytest.fail(f"pipewire_diagnostics.sh {section} did not finish in {timeout}s: {e!r}")
    return r.stdout + r.stderr


def stub(path, body):
    """Shell to write an executable stand-in at `path`."""
    return f"cat > {path} <<'STUB_EOF'\n#!/bin/sh\n{body}\nSTUB_EOF\nchmod +x {path}\n"


def test_a_process_holding_a_card_is_named_and_a_stale_probe_is_called_out(fppinit):
    """The contention check lists the non-PipeWire processes that have a pcm
    node open, with their command line, and says outright when one is a
    leftover `aplay --dump-hw-params` probe from an earlier diagnostics run.
    fuser is a stand-in naming one process, which the scenario started; a
    holder with no probe in its arguments is the control.

    Regression: bc93901e7. The check called the helper that tells its own
    children from others inside `while read -r p`, and the helper walked the
    tree in the same `p`: it came back pointing at pid 1, so every foreign
    holder read as systemd and the check reported "Only the PipeWire stack
    has sound devices open" however many strays held the card. A stray probe
    (it plays /dev/zero for ever) was never named either."""
    holder = ('bash -c \'exec -a "$0" sleep 300\' "{args}" & echo $! > /holder.pid\n')
    fuser = stub("/usr/bin/fuser", 'case "$1" in\n'
                 '  -v) echo "                     USER        PID ACCESS COMMAND"\n'
                 '      echo "/dev/snd/pcmC0D0p:   root  $(cat /holder.pid) F...m holder";;\n'
                 '  *) cat /holder.pid;;\nesac')

    out = diag(fppinit, "alsa", cards=[("Dummy", "Dummy")], pre=fuser +
               holder.format(args="aplay -D hw:0 --dump-hw-params /dev/zero"))
    assert "[WARN] Non-PipeWire processes have a sound device open" in out, out[-3000:]
    assert "Only the PipeWire stack has sound devices open" not in out, out[-3000:]
    assert "sleep -- aplay -D hw:0 --dump-hw-params /dev/zero" in out, out[-3000:]
    assert "[WARN] 1 of those are stale card probes left by an earlier" in out, out[-3000:]

    out = diag(fppinit, "alsa", cards=[("Dummy", "Dummy")], pre=fuser +
               holder.format(args="mpg123 /music/song.mp3"))
    assert "[WARN] Non-PipeWire processes have a sound device open" in out, out[-3000:]
    assert "sleep -- mpg123 /music/song.mp3" in out, out[-3000:]
    assert "stale card probes" not in out, out[-3000:]


def test_a_card_probe_that_never_returns_is_cut_off(fppinit):
    """Every `aplay --dump-hw-params` probe of a card the diagnostics make
    gives up after a few seconds: with an aplay that never returns (as one
    does on a card that accepts the raw stream, which plays /dev/zero) the
    ALSA section still finishes, and reports the card as not opening. The
    aplay is a stand-in that sleeps when asked for the parameters.

    Regression: bc93901e7. The probe had no timeout, so on a Pi's headphone
    jack it played /dev/zero for ever holding one of the card's subdevices,
    and the web request that ran the check hung until Apache's ProxyTimeout;
    eight of them left PipeWire unable to open the card at all."""
    fppinit.write("config/pipewire-audio-groups-simple.json",
                  {"groups": [{"name": "Main", "members": [{"cardId": "Dummy", "channels": 2}]}]})
    aplay = stub("/usr/bin/aplay", 'case "$*" in *--dump-hw-params*) exec sleep 300;; esac')
    start = time.monotonic()
    out = diag(fppinit, "alsa", cards=[("Dummy", "Dummy")], pre=aplay, timeout=60)
    assert time.monotonic() - start < 45, out[-2000:]
    assert "[FAIL] 'Main' member card Dummy is registered but will not open" in out, out[-3000:]


def test_a_process_holding_only_a_control_node_is_not_contention(fppinit):
    """The contention check asks about the pcm nodes only: a process with
    just a mixer (control) node open, as anything reading a volume has, is
    not reported as holding the card. fuser is a stand-in that names a
    process only when asked about the control nodes.

    Regression: 4decfeeb6. The check passed /dev/snd/control* to fuser as
    well, so every mixer reader showed up as a non-PipeWire process
    stealing the device."""
    fuser = stub("/usr/bin/fuser", 'case "$1" in\n'
                 '  -v) echo "                     USER        PID ACCESS COMMAND"\n'
                 '      echo "/dev/snd/controlC0:   root  $(cat /holder.pid) F.... mixer";;\n'
                 '  *) case "$*" in *control*) cat /holder.pid;; esac;;\nesac')
    out = diag(fppinit, "alsa", cards=[("Dummy", "Dummy")], pre=fuser +
               "sleep 300 & echo $! > /holder.pid\n")
    assert "[INFO] Processes holding ALSA devices:" in out, out[-3000:]
    assert "[PASS] Only the PipeWire stack has sound devices open" in out, out[-3000:]
    assert "Non-PipeWire processes" not in out, out[-3000:]


def test_a_cards_channels_are_what_it_advertises_not_what_the_last_opener_set(fppinit):
    """A group member asking a stereo card for two channels passes even while
    /proc/asound/cardN/pcm0p/sub0/hw_params says one (the parameters the
    current opener negotiated); a card that will not say what it supports
    is left to the other checks, with no pass or fail. The aplay is a
    stand-in printing the card's advertised parameters.

    Regression: 4decfeeb6. The check read hw_params first, and one of the
    script's own mono aplay probes is often the opener: every Pi with an
    onboard headphone jack failed with "asks card for 2 channels; it
    supports 1"."""
    fppinit.write("config/pipewire-audio-groups-simple.json",
                  {"groups": [{"name": "Main", "members": [{"cardId": "Dummy", "channels": 2}]}]})
    aplay = stub("/usr/bin/aplay", 'case "$*" in\n'
                 ' *--dump-hw-params*) case "$*" in *hw:Dummy*|*hw:0,0*) ;; *) exit 1;; esac\n'
                 '   if [ -f /busy ]; then echo "aplay: main:831: audio open error: Device or resource busy"; exit 1; fi\n'
                 '   echo "HW Params of device \\"$2\\":"; echo "CHANNELS: 2"; exit 1;;\nesac')
    opener = "mkdir -p /fake-asound/card0/pcm0p/sub0; printf 'channels: 1\\n' > /fake-asound/card0/pcm0p/sub0/hw_params\n"
    out = diag(fppinit, "alsa", cards=[("Dummy", "Dummy")], pre=aplay + opener)
    assert "[PASS] 'Main' card Dummy: 2 channel(s) within the card's 2" in out, out[-3000:]
    assert "it supports 1" not in out, out[-3000:]

    out = diag(fppinit, "alsa", cards=[("Dummy", "Dummy")], pre="touch /busy\n" + aplay + opener)
    assert "asks card Dummy" not in out and "channel(s) within" not in out, out[-3000:]


def node(i, name, cls="Audio/Sink", **props):
    """A node as pw-dump lists it."""
    return {"id": i, "type": "PipeWire:Interface:Node",
            "info": {"state": "running", "props": {"node.name": name, "media.class": cls, **props}}}


def link(i, out, inp, state="active"):
    return {"id": i, "type": "PipeWire:Interface:Link",
            "info": {"output-node-id": out, "input-node-id": inp, "state": state}}


def graph(sb, objects, section="graph", **kw):
    """The diagnostics' section, with pw-dump a stand-in listing `objects`."""
    sb.stub_output("pw-dump", "", json.dumps(objects))
    return diag(sb, section, **kw)


CONFD = "/etc/pipewire/pipewire.conf.d"


def test_the_asoundrc_that_matters_is_root_s(fppinit):
    """The config section grades /root/.asoundrc, the file fppd and the
    PipeWire services (all root) resolve ALSA through: one routing into
    PipeWire passes, one that doesn't or a missing one warns and names the
    fppinit step that writes it. A user's own ~/.asoundrc that doesn't
    mention PipeWire is context (FPP never writes it), not a warning.

    Regression: db1c71517. Every .asoundrc under /root and the fpp user's
    home was graded alike, so a base-OS file in the fpp home that FPP does
    not use was reported as a fault, and a missing /root/.asoundrc (the
    case that does lose the card to ALSA-only clients) passed as "No
    .asoundrc found"."""
    fppinit.root_file("/root/.asoundrc", "pcm.!default { type pipewire }\n")
    fppinit.root_file("/home/fpp/.asoundrc", "pcm.!default { type hw card 0 }\n")
    out = diag(fppinit, "config")
    assert "[PASS] /root/.asoundrc routes ALSA clients into PipeWire" in out, out[-3000:]
    assert "[INFO] /home/fpp/.asoundrc does not reference pipewire" in out, out[-3000:]
    assert "FPP does not use this file" in out, out[-3000:]
    assert "[WARN] /home/fpp/.asoundrc" not in out, out[-3000:]

    fppinit.root_file("/root/.asoundrc", "pcm.!default { type hw card 0 }\n")
    out = diag(fppinit, "config")
    assert "[WARN] /root/.asoundrc does not reference pipewire" in out, out[-3000:]
    assert "sudo /opt/fpp/src/fppinit bootPre" in out, out[-3000:]

    fppinit.root_file("/root/.asoundrc", None)
    out = diag(fppinit, "config")
    assert "[WARN] /root/.asoundrc missing - FPP generates this at boot" in out, out[-3000:]


def test_features_only_the_advanced_backend_has_are_skipped_in_simple_mode(fppinit):
    """With MediaBackend unset (the documented default, which is simple) or
    pipewire-simple, the leftover JSON of input mixing, AES67 and Opus RTP is
    not read: the config, graph and network sections skip them instead of
    reporting the previous mode's setup as broken. With pipewire (advanced)
    the same files are checked, and an unset MediaBackend is context, not a
    warning.

    Regression: a6039d140 (the skips) and 4decfeeb6 (unset counts as
    simple). Switching to simple mode left pipewire-input-groups.json and
    the others behind, and every group in them was reported as missing from
    the graph; a device that had never written the setting was treated as
    advanced and read them all."""
    fppinit.write("config/pipewire-input-groups.json", {"inputGroups": [{"name": "Mix", "members": []}]})
    fppinit.write("config/pipewire-aes67-instances.json", {"instances": [{"name": "tx", "enabled": True}]})
    fppinit.write("config/pipewire-opus-rtp-instances.json", {"instances": [{"name": "o", "enabled": True}]})
    objects = [node(40, "some_sink")]

    for backend in ("", "pipewire-simple"):
        fppinit.write("settings", f'MediaBackend = "{backend}"\n' if backend else "")
        out = diag(fppinit, "config")
        assert "[SKIP] Input groups configured for advanced mode - not generated in simple mode" in out, \
            f"{backend!r}: {out[-3000:]}"
        if not backend:
            assert "[INFO] MediaBackend is not set; FPP uses its default, pipewire-simple" in out, out[-3000:]
        out = graph(fppinit, objects)
        assert "[SKIP] Input mixing is an advanced-mode feature - not used in simple mode" in out, \
            f"{backend!r}: {out[-3000:]}"
        out = diag(fppinit, "network")
        assert "[SKIP] AES67 is an advanced-mode feature - not started in simple mode" in out, \
            f"{backend!r}: {out[-3000:]}"
        assert "[SKIP] Opus RTP is an advanced-mode feature - not started in simple mode" in out, \
            f"{backend!r}: {out[-3000:]}"

    fppinit.write("settings", 'MediaBackend = "pipewire"\n')
    out = diag(fppinit, "config")
    assert "[FAIL] Input groups are configured but 96-fpp-input-groups.conf was never generated" in out, out[-3000:]
    out = diag(fppinit, "network")
    assert "[INFO] Enabled AES67 streams: 1" in out, out[-3000:]
    assert "advanced-mode feature" not in out, out[-3000:]


def test_two_alsa_adapters_under_one_node_name_fail_but_other_stacks_may_repeat_a_name(fppinit):
    """The graph section fails a node name that two ALSA adapters share (the
    second to open the PCM gets EBUSY), naming the generated conf lines that
    declare it; four v4l2 nodes sharing one name, as a Pi's camera ISP
    publishes them, are context. pw-dump is a stand-in.

    Regression: a6039d140 (the check), 4decfeeb6 (only ALSA nodes count).
    The check reported the ISP's four v4l2_input nodes as a duplicate
    adapter fault and sent people looking for an audio problem that does
    not exist."""
    fppinit.root_file(f"{CONFD}/90-fpp.conf", "context.properties = { }\n")  # grep names files only from two
    fppinit.root_file(f"{CONFD}/97-fpp-audio-groups.conf",
                      '    node.name = "fpp_alsa_dup"\n    node.name = "fpp_alsa_ok"\n')
    alsa = [node(40, "fpp_alsa_dup", **{"api.alsa.path": "hw:1"}),
            node(41, "fpp_alsa_dup", **{"api.alsa.path": "hw:1"}), node(42, "fpp_alsa_ok")]
    out = graph(fppinit, alsa)
    assert "[FAIL] Node name 'fpp_alsa_dup' exists 2 times in the graph" in out, out[-3000:]
    assert "id=40 " in out and "id=41 " in out, out[-3000:]
    assert "Declared at:" in out and "97-fpp-audio-groups.conf:1\n" in out, out[-3000:]
    assert "Two adapters on one PCM: the second to open gets EBUSY" in out, out[-3000:]

    v4l2 = [node(50 + i, "v4l2_input.platform-bcm2835-isp", "Video/Source") for i in range(4)]
    out = graph(fppinit, v4l2)
    assert "[INFO] Node name 'v4l2_input.platform-bcm2835-isp' is used by 4 nodes (not ALSA sinks" in out, out[-3000:]
    assert "[FAIL] Node name" not in out, out[-3000:]

    out = graph(fppinit, [node(60, "a"), node(61, "b")])
    assert "[PASS] Every node in the graph has a unique name" in out, out[-3000:]


def test_a_missing_card_node_is_explained_by_the_state_of_the_card(fppinit):
    """A node the config declares (and a link target) that the graph lacks is
    followed by what the card behind it is doing: an HDMI socket with no
    display ("expected while the socket is empty"), a card that will not
    open, or one that opens and so needs the services restarted. The node
    is fpp_alsa_s3 and the target fpp_alsa_s4, cards S3 and S4: the id is recovered in its real case,
    or the probe would be of a card that does not exist. /proc/asound is
    served from a directory, aplay is a stand-in, pw-dump lists an
    unrelated sink.

    Regression: a11066ccc. The failure said only that the card was
    "unplugged, renamed, or held by another process", leaving the person at
    the machine to find out which of a socket with nothing in it, a
    monitor in standby, and a start-order problem it was."""
    fppinit.root_file(f"{CONFD}/97-fpp-audio-groups.conf",
                      '    node.name = "fpp_alsa_s3"\n    node.target = "fpp_alsa_s4"\n')
    aplay = stub("/usr/bin/aplay", 'case "$*" in\n'
                 ' *"-D hw:S"[34]" --dump-hw-params"*)\n'
                 '   if [ -f /opens ]; then echo "HW Params of device \\"$2\\":"; exit 1; fi\n'
                 '   echo "aplay: main:831: audio open error: Invalid argument"; exit 1;;\n'
                 ' *--dump-hw-params*) echo "aplay: main:831: audio open error: No such device"; exit 1;;\nesac')
    eld = "/fake-asound/card0/eld#0.0"

    fppinit.root_file(eld, "monitor_present\t\t0\neld_valid\t\t0\n")
    fppinit.root_file("/fake-asound/card1/eld#0.0", "monitor_present\t\t0\neld_valid\t\t0\n")
    out = graph(fppinit, [node(40, "unrelated_sink")], cards=[("S3", "HDA-Intel"), ("S4", "HDA-Intel")], pre=aplay)
    assert "[FAIL] Declared but not in the graph: fpp_alsa_s3" in out, out[-3000:]
    assert "S3: no display is attached - an HDMI socket with nothing in it, and the device will not open" in out, \
        out[-3000:]
    assert "[FAIL] Target fpp_alsa_s4 exists nowhere" in out, out[-3000:]
    assert "S4: no display is attached - an HDMI socket with nothing in it, and the device will not open" in out, \
        out[-3000:]
    assert "Nothing is plugged into that socket" in out and "the socket is empty" in out, out[-3000:]

    shown = "monitor_present\t\t1\neld_valid\t\t1\nmonitor_name\t\tFPP Test Display\n"
    fppinit.root_file(eld, shown)
    fppinit.root_file("/fake-asound/card1/eld#0.0", shown)
    out = graph(fppinit, [node(40, "unrelated_sink")], cards=[("S3", "HDA-Intel"), ("S4", "HDA-Intel")], pre="touch /opens\n" + aplay)
    assert "S3: a display is attached (FPP Test Display), and the device opens right now" in out, out[-3000:]
    assert "S4: a display is attached (FPP Test Display), and the device opens right now" in out, out[-3000:]
    assert "It opens now but has no node, so it was not ready when" in out, out[-3000:]
    assert "sudo systemctl restart fpp-pipewire fpp-wireplumber fpp-pipewire-pulse" in out, out[-3000:]
    assert "The card opens, so the node should exist - restart the" in out, out[-3000:]


def test_a_group_sink_is_fed_through_its_member_streams(fppinit):
    """A group sink (a combine-stream) carries no links itself: the links
    leave the output.<sink>_<member> stream nodes it makes. The graph
    section counts a sink as feeding something when any of those has an
    outgoing link, and lists as feeding nothing only a sink with none.
    pw-dump is a stand-in with a fully linked group and an unlinked one.

    Regression: 35319d20a. Only the sink's own id was looked at, so every
    healthy group in the graph was reported as feeding nothing."""
    objects = [
        node(10, "fpp_group_main"),
        node(11, "output.fpp_group_main_fpp_fx_g1_s3", "Stream/Output/Audio"),
        node(12, "fpp_fx_g1_s3"),
        link(50, 11, 12),
        node(20, "fpp_group_lonely"),
        node(21, "output.fpp_group_lonely_fpp_fx_g2_s4", "Stream/Output/Audio"),
    ]
    out = graph(fppinit, objects)
    assert "[WARN] These FPP sinks feed nothing" in out, out[-3000:]
    listed = out.split("These FPP sinks feed nothing", 1)[1].split("---", 1)[0]
    assert "fpp_group_lonely" in listed and "fpp_group_main" not in listed, out[-3000:]

    out = graph(fppinit, objects[:4])
    assert "[PASS] Every FPP group sink has at least one outgoing link" in out, out[-3000:]


def test_rtsp_output_checks_read_the_mounts_from_the_video_output_groups(fppinit):
    """With RTSP output enabled the network section reads its mounts from
    pipewire-video-consumers.json (type rtsp), not the outputs file: none
    is a warning that the server is only started once a mount exists, mounts
    with no video source are a failure, a servable mount with nothing
    listening names fppd, a port out of range falls back to 8554 with a
    warning, and in simple mode (no video output groups) it is skipped.
    ss and pgrep are the sandbox's: nothing listens and no fppd runs.

    Regression: 9080b47ee (the mounts and the source check), 35319d20a (the
    simple mode skip). The check read .streams[] out of the outputs file, a
    key that never exists, so every device looked like it had no streams,
    and a leftover enabled flag in simple mode was reported."""
    fppinit.write("settings", 'MediaBackend = "pipewire"\n')
    fppinit.write("config/pipewire-rtsp-outputs.json", {"enabled": True, "port": 8554})

    out = diag(fppinit, "network")
    assert "[WARN] RTSP output is enabled but no Video Output Group member serves it" in out, out[-3000:]
    assert "nothing listening on port 8554 is expected here" in out, out[-3000:]

    fppinit.write("config/pipewire-video-consumers.json", [{"type": "rtsp", "name": "cam", "mountPoint": "/cam"}])
    out = diag(fppinit, "network")
    assert "[FAIL] 1 RTSP mount(s) exist but none names a video source" in out, out[-3000:]
    assert "cam  mount=/cam  source=NONE" in out, out[-3000:]

    fppinit.write("config/pipewire-video-consumers.json",
                  [{"type": "rtsp", "name": "cam", "mountPoint": "/cam", "sourceNode": "video_src"},
                   {"type": "hdmi", "name": "screen"}])
    out = diag(fppinit, "network")
    assert "source=video_src" in out, out[-3000:]
    assert "[FAIL] Nothing is listening on RTSP port 8554 because fppd is not running" in out, out[-3000:]

    fppinit.write("config/pipewire-rtsp-outputs.json", {"enabled": True, "port": 80})
    out = diag(fppinit, "network")
    assert "[WARN] Port 80 is out of range; fppd falls back to 8554" in out, out[-3000:]
    assert "RTSP port 8554 because fppd is not running" in out, out[-3000:]

    fppinit.write("config/pipewire-video-consumers.json", [])
    fppinit.write("settings", 'MediaBackend = "pipewire-simple"\n')
    out = diag(fppinit, "network")
    assert "[SKIP] RTSP output is enabled but its mounts are an advanced-mode feature" in out, out[-3000:]


def test_the_service_journal_is_read_from_the_last_start_or_config_change(fppinit):
    """The services section reads the PipeWire units' journal only back to
    the later of a service start and the newest generated conf, counts the
    headless messages that are always there (no session bus, portal,
    jackdbus, camera) apart from the errors, and says which boundary it
    used. journalctl is a stand-in that honours --since @<epoch> and holds
    an error from before the conf was written, one after, and a session
    bus failure after.

    Regression: 519eec795. The journal for these units survives reboots and
    the check grepped the last 400 lines, so failures of configurations
    that no longer exist were reported as current (on the device it was
    written against, 55818 matching lines across weeks against 16 for the
    running instance) and the structural session-bus failures were listed
    as faults."""
    fppinit.root_file(f"{CONFD}/90-fpp.conf", "context.properties = { }\n")
    journalctl = stub("/usr/bin/journalctl", r'''now=$(date +%s)
since=0
for a in "$@"; do case "$a" in @*) since=${a#@};; esac; done
{ echo "$((now - 86400)) fpp-pipewire: error: a failure from before the conf was regenerated"
  echo "$((now + 86400)) fpp-pipewire: error: the sink failed to open"
  echo "$((now + 86400)) fpp-pipewire: error: Failed to connect to session bus"
  echo "$((now + 86400)) fpp-wireplumber: all is well"; } | awk -v s="$since" '$1 >= s' ''')
    out = diag(fppinit, "services", pre=journalctl)
    assert "(the configuration was last generated)" in out, out[-3000:]
    assert "[WARN] 1 error(s) in the service journal:" in out, out[-3000:]
    assert "the sink failed to open" in out, out[-3000:]
    assert "a failure from before the conf was regenerated" not in out, out[-3000:]
    assert "[INFO] 1 more are the usual headless messages" in out, out[-3000:]
    assert "session bus" not in out.split("[WARN] 1 error(s)", 1)[1].split("[INFO] 1 more", 1)[0], out[-3000:]


def test_blacklisted_gstreamer_plugins_fpp_never_loads_do_not_warn(fppinit):
    """gst-inspect -b listing only libgstonnx (optional ML plugin, Debian
    ships it without its runtime so it blacklists on a healthy player) is a
    pass with an info line; one more blacklisted file FPP may need makes it
    a warning naming that file and not the ONNX one. gst-inspect-1.0 is a
    stand-in.

    Regression: 4decfeeb6. Any blacklisted file warned, so every Debian
    player had a standing GStreamer warning with nothing to fix."""
    def gst(files):
        body = "\n".join(f"  {f}" for f in files)
        return stub("/usr/bin/gst-inspect-1.0",
                    'case "$1" in\n -b) printf "Blacklisted files:\\n%s\\n\\nTotal count: %d blacklisted files\\n" '
                    f"'{body}' {len(files)};;\n *) exit 0;;\nesac")
    out = diag(fppinit, "gstreamer", pre=gst(["libgstonnx.so"]))
    assert "[PASS] No blacklisted GStreamer plugins that FPP uses" in out, out[-3000:]
    assert "1 blacklisted file(s), all optional plugins FPP never loads" in out, out[-3000:]
    assert "[WARN] GStreamer has blacklisted" not in out, out[-3000:]

    out = diag(fppinit, "gstreamer", pre=gst(["libgstonnx.so", "libgstrealplugin.so"]))
    assert "[WARN] GStreamer has blacklisted plugin file(s) FPP may need:" in out, out[-3000:]
    listed = out.split("FPP may need:", 1)[1].split("A blacklisted plugin failed", 1)[0]
    assert "libgstrealplugin.so" in listed and "libgstonnx" not in listed, out[-3000:]


def test_the_aes67_clock_rate_check_names_the_files_that_set_it(fppinit):
    """With an AES67 stream enabled the network section compares the graph's
    clock.rate with AES67's 48000: a match passes; a graph at another rate
    warns (PipeWire resamples into the sender), says whether 48000 is in
    clock.allowed-rates, and lists the conf.d files that set
    default.clock.rate in the order they are read, the last one winning.
    pw-metadata is a stand-in for the settings metadata.

    Regression: 7ea744621. A graph at 44100 under an AES67 stream was left
    to be inferred from a rate printed in another section, and which file
    won (a higher-numbered generated conf overrides 90-fpp.conf) cost an
    editing session on a file that was being overridden."""
    fppinit.write("settings", 'MediaBackend = "pipewire"\n')
    fppinit.write("config/pipewire-aes67-instances.json",
                  {"instances": [{"name": "tx", "enabled": True, "multicastIP": "239.69.1.1", "channels": 2}]})
    fppinit.root_file(f"{CONFD}/90-fpp.conf", "context.properties = {\n  default.clock.rate = 48000\n}\n")
    fppinit.root_file(f"{CONFD}/99-test.conf", "context.properties = {\n  default.clock.rate = 44100\n}\n")

    def metadata(rate, allowed):
        return stub("/usr/bin/pw-metadata", f'echo "Found \\"settings\\" metadata 12"\n'
                    f"echo \"update: id:0 key:'clock.rate' value:'{rate}' type:''\"\n"
                    f"echo \"update: id:0 key:'clock.allowed-rates' value:'{allowed}' type:''\"")

    out = diag(fppinit, "network", pre=metadata(44100, "[ 44100, 48000 ]"))
    assert "[WARN] Graph clock is 44100 Hz, but AES67 is 48000 Hz only" in out, out[-3000:]
    assert "48000 is in clock.allowed-rates, so the graph can switch to it." in out, out[-3000:]
    chain = out.split("in the order conf.d reads them:", 1)[1]
    assert chain.index("90-fpp.conf = 48000") < chain.index("99-test.conf = 44100"), out[-3000:]
    assert "The last one listed wins." in out, out[-3000:]

    out = diag(fppinit, "network", pre=metadata(44100, "[ 44100 ]"))
    assert "48000 is NOT in clock.allowed-rates ([ 44100 ]), so the" in out, out[-3000:]

    out = diag(fppinit, "network", pre=metadata(48000, "[ 44100, 48000 ]"))
    assert "[PASS] Graph clock is 48000 Hz, matching AES67" in out, out[-3000:]


def test_aes67_multicast_routing_follows_the_interface_a_stream_names(fppinit):
    """The network section's multicast checks: with two interfaces up and a
    stream naming none, a warning that suggests a wired interface for the
    224.0.0.0/4 route and one that SAP follows the default route too; with
    every stream naming an interface the routing table is not consulted
    (pass), SAP goes out the PTP interface, and a stream pinned to an
    interface that does not exist fails. `ip` is a stand-in with eth0 and
    eth1 up.

    Regression: fef5ef060. The check warned about the routing table for
    every stream however it was pinned (the sender is built with
    multicast-iface, which the kernel honours ahead of the table), and
    advised a hardcoded eth0."""
    fppinit.write("settings", 'MediaBackend = "pipewire"\n')
    ip = stub("/usr/sbin/ip", 'case "$*" in\n'
              '  "-o link show up") printf "1: lo: <LOOPBACK,UP>\\n2: eth0: <UP>\\n3: eth1: <UP>\\n";;\n'
              '  "route show") ;;\n  "link show eth0"|"link show eth1") ;;\n  "link show "*) exit 1;;\nesac')

    def run(instance, **top):
        fppinit.write("config/pipewire-aes67-instances.json", {
            "instances": [{"name": "tx", "enabled": True, "multicastIP": "239.69.1.1", "channels": 2, **instance}],
            **top})
        return diag(fppinit, "network", pre=ip)

    out = run({})
    assert "[WARN] 1 AES67 stream(s) name no interface, and 2 interfaces are up" in out, out[-3000:]
    assert "sudo ip route add 224.0.0.0/4 dev eth0" in out, out[-3000:]
    assert "[WARN] SAP announcements are not pinned to an interface" in out, out[-3000:]

    out = run({"interface": "eth1"}, ptpInterface="eth1")
    assert "iface=eth1" in out and "tx -> eth1" in out, out[-3000:]
    assert "[PASS] No explicit multicast route, but every enabled AES67 stream names its own interface" in out, \
        out[-3000:]
    assert "[INFO] SAP announcements go out eth1 (the PTP interface)" in out, out[-3000:]
    assert "[WARN] 1 AES67 stream(s)" not in out, out[-3000:]

    out = run({"interface": "eth9"})
    assert "[FAIL] AES67 stream 'tx' is pinned to eth9, which does not exist" in out, out[-3000:]


def test_xruns_are_counted_from_the_err_column_of_the_last_snapshot(fppinit):
    """The performance section sums the ERR column of pw-top's final snapshot
    only, found by its header: the first pass of `pw-top -n 2` is a priming
    snapshot, and the WAIT column ahead of ERR ("852.3us") must not be read
    as a count. pw-top is a stand-in whose first snapshot has 40 on the
    card's node and whose last has 2 and a WAIT of 852.3us.

    Regression: 7ea744621. The count was field 5 of every line of both
    snapshots with the non-digits stripped: WAIT read as 8523, and the
    totals came out in the thousands."""
    head = "S   ID  QUANT   RATE    WAIT    BUSY   W/Q   B/Q  ERR FORMAT           NAME"
    pw_top = stub("/usr/bin/pw-top",
                  f'echo "{head}"\n'
                  'echo "R   40   1024  48000  852.3us  30.0us  0.00  0.00   40    S16LE 2 48000 fpp_alsa_card0"\n'
                  f'echo "{head}"\n'
                  'echo "R   40   1024  48000  852.3us  30.0us  0.00  0.00    2    S16LE 2 48000 fpp_alsa_card0"')
    out = diag(fppinit, "performance", pre=pw_top)
    assert "[WARN] 2 xrun(s) on the audio device since the graph started" in out, out[-3000:]
    assert "       2  fpp_alsa_card0" in out, out[-3000:]


def test_the_capture_check_records_from_a_source_in_the_graph(fppd, audio):
    """The smoke section's capture check runs pw-record against an audio
    source in the graph and passes on the bytes that landed in the file
    ("Captured N bytes from <source>"), skipping when the graph has no
    source. Against the scenario's own PipeWire (the audio fixture, where
    the script looks: /run/pipewire-fpp) first with only the null sink,
    then with a loopback source made the default.

    Regression: ca941ee64. The check ran `gst-launch-1.0 pipewiresrc` at no
    target, which times out rather than failing (so a warning had nothing
    to print) and says nothing about whether the daemon hands a client
    capture data, which is what the input groups read.

    Also guards the default-source lookup: the script read
    default.audio.source from the settings metadata, where it never is, so it
    always fell back to the first source in the graph."""
    from audio import env

    # The script points clients at /etc/pipewire, which has client.conf on a
    # device and not in the container.
    conf = "/etc/pipewire/client.conf"
    made = not os.path.exists(conf)
    if made:
        os.makedirs(os.path.dirname(conf), exist_ok=True)
        shutil.copy("/usr/share/pipewire/client.conf", conf)

    def smoke():
        r = subprocess.run(["bash", f"{fppd.tree}/scripts/pipewire_diagnostics.sh", "smoke"],
                           capture_output=True, text=True, env=env(), timeout=120)
        return r.stdout + r.stderr

    fppd.start()
    source = None
    try:
        out = smoke()
        assert "--- Capture from PipeWire ---" in out, out[-3000:]
        # The graph's default source is the null sink's monitor (the
        # server makes it the default source when no real source exists).
        capture = out.split("--- Capture from PipeWire ---", 1)[1].split("---", 1)[0]
        assert "[PASS] Captured " in capture and " bytes from fpp_test_sink" in capture, out[-3000:]

        # A source that carries data, as a capture card's does: a loopback
        # from the null sink's monitor (a null sink given the Audio/Source
        # class records nothing), made the default source.
        source = subprocess.Popen(
            ["pw-loopback", "-n", "fpp_test_loop",
             "--capture-props=target.object=fpp_test_sink stream.capture.sink=true node.name=fpp_test_loop_in",
             "--playback-props=media.class=Audio/Source node.name=fpp_test_source"],
            env=env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while "fpp_test_source" not in subprocess.run(["pw-cli", "ls", "Node"], env=env(), capture_output=True,
                                                      text=True).stdout:
            assert time.monotonic() < deadline, "the test source never appeared"
            time.sleep(0.25)
        subprocess.run(["pw-metadata", "-n", "default", "0", "default.audio.source",
                        '{"name":"fpp_test_source"}', "Spa:String:JSON"], env=env(), check=True, timeout=10)
        out = smoke()
        capture = out.split("--- Capture from PipeWire ---", 1)[1].split("---", 1)[0]
        assert "[PASS] Captured " in capture and " bytes from fpp_test_source" in capture, \
            "the default source was not the one recorded from: " + out[-3000:]
    finally:
        if source:
            source.terminate()
        if made:
            os.remove(conf)
