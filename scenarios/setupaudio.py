"""fppinit's setupAudio on a device's sound cards, and what PipeWire makes of
the config it writes.

The fppinit sandbox (fppinit.py) sees the device's /proc/asound and /sys,
so setupAudio finds the cards that are really there; it has no /dev/snd,
so aplay is a stub (APLAY) that lists those cards and answers the hardware
parameter dumps and the format/rate probes as a scenario sets them up.
box() sets a sandbox up as a box with one card selected.

CardGraph is the receiving end: a PipeWire and WirePlumber of the
scenario's own that load the confs setupAudio wrote -- and only those, with
FPP's own shipped defaults -- against the real cards, so a test can see
which nodes PipeWire created from them and, playing silence through one,
what the card itself was opened with (/proc/asound/cardN/.../hw_params).
The device's own PipeWire keeps running beside it; the cards are free
while that one is idle (it suspends them). Nothing here plays to an HDMI
card: CardGraph refuses a conf whose adapters name one.

Needs a device with a sound card: run-local.sh (verified on a Pi 4 with a
USB card and the headphone jack).
"""

import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import wave

from test_fppinit_audio_cards import CARRIED, CONF, node, set_setting

SIMPLE_JSON = "config/pipewire-audio-groups-simple.json"
GROUPS_JSON = "config/pipewire-audio-groups.json"
INPUT_JSON = "config/pipewire-input-groups.json"


def proc_cards():
    """[(index, id, driver, name)] from /proc/asound/cards."""
    out = []
    try:
        with open("/proc/asound/cards") as f:
            for line in f:
                m = re.match(r"^\s*(\d+) \[(\S+)\s*\]: (\S+) - (.*)$", line)
                if m:
                    out.append((int(m.group(1)), m.group(2), m.group(3), m.group(4).strip()))
    except OSError:
        pass
    return out


def proc_pcms():
    """{card index: (pcm name, playback?, capture?)} for device 0, from /proc/asound/pcm."""
    pcms = {}
    try:
        with open("/proc/asound/pcm") as f:
            for line in f:
                m = re.match(r"^(\d+)-00: ([^:]+?) : [^:]+ : (.*)$", line)
                if m:
                    pcms[int(m.group(1))] = (m.group(2), "playback" in m.group(3), "capture" in m.group(3))
    except OSError:
        pass
    return pcms


def is_hdmi(card):
    return "hdmi" in (card[1] + card[2] + card[3]).lower()


def usb_card():
    """The first USB sound card with playback, or None."""
    pcms = proc_pcms()
    for c in proc_cards():
        if c[2] == "USB-Audio" and pcms.get(c[0], ("", False, False))[1]:
            return c
    return None


def onboard_card():
    """The first card that is neither USB, HDMI nor a dummy, or None."""
    pcms = proc_pcms()
    for c in proc_cards():
        if c[2] != "USB-Audio" and not is_hdmi(c) and c[1] not in ("Dummy", "Loopback") \
                and pcms.get(c[0], ("", False, False))[1]:
            return c
    return None


def dump(card_id, formats="S16_LE", channels="2", rates="[8000 192000]"):
    """What aplay --dump-hw-params prints for a card."""
    return (f'HW Params of device "hw:{card_id}":\n--------------------\n'
            "ACCESS:  MMAP_INTERLEAVED RW_INTERLEAVED\n"
            f"FORMAT:  {formats}\nSUBFORMAT:  STD\n"
            f"CHANNELS: {channels}\nRATE: {rates}\n"
            "PERIOD_SIZE: [80 131072]\nBUFFER_SIZE: [80 131072]\n--------------------\n")


# aplay as setupAudio runs it, with no /dev/snd. Logs each call as the
# sandbox's stubs do, then:
#   -l                      the listing in /fppinit-state/aplay.-l.out
#   -D DEV --dump-hw-params /fppinit-state/aplay.DEV.out, or an open error
#   -D DEV -f FMT -r RATE   a probe: plays the silence it is fed, after the
#                           banner aplay prints before negotiating anything;
#                           /fppinit-state/aplay-open.DEV.FMT says "fail"
#                           (the format is refused: exit 1) or the rate the
#                           driver settles on (warned about, exit 0); with
#                           no file it opens at the rate asked for.
APLAY = r"""#!/bin/sh
printf '%s\n' "aplay $*" >> /fppinit-calls.log
S=/fppinit-state
dev= fmt= rate= dumpp= list=
while [ $# -gt 0 ]; do
    case "$1" in
        -D) dev=$2; shift ;;
        -f) fmt=$2; shift ;;
        -r) rate=$2; shift ;;
        --dump-hw-params) dumpp=1 ;;
        -l) list=1 ;;
    esac
    shift
done
if [ -n "$list" ]; then cat "$S/aplay.-l.out" 2>/dev/null; exit 0; fi
if [ -n "$dumpp" ]; then
    if [ -f "$S/aplay.$dev.out" ]; then cat "$S/aplay.$dev.out"; exit 0; fi
    echo "aplay: main:850: audio open error: No such device" >&2
    exit 1
fi
[ -z "$fmt" ] && exit 0
cat > /dev/null
echo "Playing raw data '-' : $fmt, Rate $rate Hz, Stereo" >&2
got=$rate
[ -f "$S/aplay-open.$dev.$fmt" ] && got=$(cat "$S/aplay-open.$dev.$fmt")
if [ "$got" = fail ]; then
    echo "aplay: set_params:1352: Sample format non available" >&2
    exit 1
fi
if [ "$got" != "$rate" ]; then
    echo "Warning: rate is not accurate (requested = ${rate}Hz, got = ${got}Hz)" >&2
    echo "         please, try the plug plugin" >&2
fi
exit 0
"""


def box(sb, backend, selected, dumps=None, groups=None, cards=None, names=None):
    """sb as a box whose AudioOutput is `selected` (an ALSA card ID, or
    whatever the setting should hold), with no PipeWire config of the
    device's own: the first run probes from scratch. dumps: {card id: aplay
    --dump-hw-params text} for the playback cards the stub answers for
    (default: every non-HDMI one, as S16_LE stereo); the others fail to
    open. groups: an Advanced groups JSON. cards: the card list to show
    instead of the device's own ([(index, id, driver, name)], also bound
    over /proc/asound/cards); names: {card id: the bracketed name and
    device text of its "aplay -l" line}, for a card to look like another."""
    pcms = proc_pcms()
    if cards is None:
        cards = proc_cards()
    else:
        sb.fake_path("/proc/asound/cards", "".join(
            f"{i:2d} [{cid:<15}]: {drv} - {name}\n{'':22}{name}\n" for i, cid, drv, name in cards))
        real = {c[1]: c[0] for c in proc_cards()}
        pcms = {i: pcms.get(real.get(cid), ("USB Audio", True, False)) for i, cid, drv, name in cards}
    set_setting(sb, MediaBackend=backend, AudioOutput=selected)
    if dumps is None:
        dumps = {c[1]: dump(c[1]) for c in cards if not is_hdmi(c) and pcms.get(c[0], ("", 0, 0))[1]}
    play = "**** List of PLAYBACK Hardware Devices ****\n"
    cap = "**** List of CAPTURE Hardware Devices ****\n"
    for i, cid, drv, name in cards:
        pcm, p, c = pcms.get(i, (name, False, False))
        short = name.split(" at ")[0] if drv == "USB-Audio" else name
        text = (names or {}).get(cid, f"[{short}], device 0: {pcm} [{pcm}]")
        line = f"card {i}: {cid} {text}\n  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n"
        play += line if p else ""
        cap += line if c else ""
        if c:
            sb.stub_output("arecord", f"hw:{cid}", dump(cid))
    sb.stub_output("aplay", "-l", play)
    sb.stub_output("arecord", "-l", cap)
    for cid, text in dumps.items():
        sb.stub_output("aplay", f"hw:{cid}", text)
    sb.root_file("/usr/bin/aplay", APLAY)
    sb.stub_output("amixer", "scontrols", "Simple mixer control 'PCM',0\n")
    # The stack's sinks come up, so setupAudio doesn't wait 30 s for them
    # and then discard the config to start over.
    sb.stub_output("pactl", "list", f"1\tfpp_alsa_{node(selected)}\tPipeWire\ts16le 2ch 44100Hz\tSUSPENDED\n")
    for path in CARRIED + (CONF + "96-fpp-input-groups.conf", CONF + "94-fpp-vban.conf"):
        sb.root_file(path, None)
    if groups is not None:
        sb.write(GROUPS_JSON, groups)


def probe_result(sb, dev, fmt, result):
    """How the stub aplay's probe of `dev` in ALSA format `fmt` ends: "fail",
    or the rate (an int) the driver settles on."""
    with open(os.path.join(sb.state, f"aplay-open.{dev}.{fmt}"), "w") as f:
        f.write(f"{result}\n")


def group(name, *cids, gid=1):
    return {"id": gid, "name": name, "enabled": True, "channels": 2, "volume": 100,
            "members": [{"cardId": c, "channels": 2, "delayMs": 0, "volume": 100} for c in cids]}


def adapter(conf, name):
    """The args block of the adapter `name` in a conf, as {key: value}, or None."""
    m = re.search(r'\{ factory = adapter\s*args = \{([^{}]*?node\.name = "' + re.escape(name)
                  + r'"[^{}]*?)\}', conf or "", re.S)
    if not m:
        return None
    out = {}
    for k, v in re.findall(r"^\s*([\w.-]+) = (.+?)\s*$", m.group(1), re.M):
        out[k] = v.strip('"')
    return out


class CardGraph:
    """A private PipeWire + WirePlumber loading `confs` ({file name: text},
    as setupAudio wrote them to /etc/pipewire/pipewire.conf.d) against the
    device's real cards. Use as a context manager."""

    def __init__(self, tree, confs):
        for name, text in confs.items():
            for path in re.findall(r'api\.alsa\.path = "([^"]*)"', text or ""):
                assert "hdmi" not in path.lower(), f"{name}: refusing to open an HDMI card ({path})"
        self.dir = tempfile.mkdtemp(prefix="cardgraph-")
        pw = os.path.join(self.dir, "pw")
        wp = os.path.join(self.dir, "wp")
        os.makedirs(os.path.join(pw, "pipewire.conf.d"))
        os.makedirs(os.path.join(wp, "wireplumber.conf.d"))
        for f in ("pipewire.conf", "client.conf"):
            shutil.copy(os.path.join("/usr/share/pipewire", f), pw)
        shutil.copy("/usr/share/wireplumber/wireplumber.conf", wp)
        shutil.copy(os.path.join(tree, "etc/pipewire/pipewire.conf.d/90-fpp.conf"),
                    os.path.join(pw, "pipewire.conf.d"))
        for name, text in confs.items():
            if text is not None:
                with open(os.path.join(pw, "pipewire.conf.d", name), "w") as f:
                    f.write(text)
        hook = os.path.join(tree, "etc/wireplumber/wireplumber.conf.d/60-fpp-block-combine-fallback.conf")
        if os.path.exists(hook):
            shutil.copy(hook, os.path.join(wp, "wireplumber.conf.d"))
        # The device's profile (10-fpp-alsa.conf) without its ALSA monitor:
        # the cards this graph has are the adapters in the confs, nothing else.
        with open(os.path.join(wp, "wireplumber.conf.d", "10-cardgraph.conf"), "w") as f:
            f.write("wireplumber.profiles = {\n  main = {\n"
                    "    inherits = [ base, mixin.systemwide-session ]\n"
                    "    metadata.sm-settings = required\n    metadata.sm-objects = required\n"
                    "    policy.standard = required\n    hardware.audio = disabled\n"
                    "    hardware.bluetooth = disabled\n    hardware.video-capture = disabled\n"
                    "  }\n}\n")
        run = os.path.join(self.dir, "run")
        os.makedirs(run)
        self.env = dict(os.environ)
        self.env.update(PIPEWIRE_RUNTIME_DIR=run, XDG_RUNTIME_DIR=run, PIPEWIRE_CONFIG_DIR=pw,
                        WIREPLUMBER_CONFIG_DIR=wp, XDG_STATE_HOME=os.path.join(self.dir, "state"),
                        XDG_CONFIG_HOME=os.path.join(self.dir, "cfg"))
        self.env.pop("PULSE_RUNTIME_PATH", None)
        scripts = os.path.join(tree, "etc/wireplumber/scripts")
        if os.path.exists(hook) and os.path.isdir(scripts):
            # The hook's script, which only a device has installed: without
            # it (Docker) WirePlumber refuses the profile and links nothing.
            shutil.copytree(scripts, os.path.join(self.dir, "data", "wireplumber", "scripts"))
            self.env["XDG_DATA_HOME"] = os.path.join(self.dir, "data")
        self.logpath = os.path.join(self.dir, "daemons.log")
        self.log = open(self.logpath, "w")
        self.procs = []
        # run-local.sh hides /dev/snd under a tmpfs; this daemon alone gets
        # the real one back, in a mount namespace of its own.
        self._start(["unshare", "--mount", "sh", "-c",
                     'if mountpoint -q /dev/snd; then umount /dev/snd; fi; exec "$@"', "sh", "pipewire"])
        deadline = time.monotonic() + 10
        while subprocess.run(["pw-cli", "info", "0"], env=self.env, capture_output=True).returncode:
            if time.monotonic() > deadline:
                self.close()
                raise RuntimeError("the scenario's PipeWire never came up:\n" + self.daemon_log())
            time.sleep(0.2)
        self._start(["wireplumber"])
        time.sleep(1.5)

    def _start(self, argv):
        self.procs.append(subprocess.Popen(argv, env=self.env, stdout=self.log, stderr=self.log,
                                           start_new_session=True))

    def daemon_log(self):
        self.log.flush()
        with open(self.logpath, errors="replace") as f:
            return f.read()[-4000:]

    def objects(self):
        out = subprocess.run(["pw-dump"], env=self.env, capture_output=True, text=True, timeout=20).stdout
        return json.loads(out or "[]")

    def nodes(self):
        """{node.name: props} of every node in the graph."""
        return {o["info"]["props"].get("node.name"): o["info"]["props"]
                for o in self.objects() if o.get("type") == "PipeWire:Interface:Node"}

    def clock_rate(self):
        """default.clock.rate as the daemon took it from its config."""
        for o in self.objects():
            if o.get("type") == "PipeWire:Interface:Metadata" and o.get("props", {}).get("metadata.name") == "settings":
                for m in o.get("metadata") or []:
                    if m.get("key") == "clock.rate":
                        return int(m["value"])
        return None

    def wait_node(self, name, timeout=10):
        deadline = time.monotonic() + timeout
        while True:
            n = self.nodes()
            if name in n:
                return n[name]
            if time.monotonic() > deadline:
                return None
            time.sleep(0.25)

    def play(self, target, seconds=4, rate=44100, channels=2):
        """Play `seconds` of silence (a 16-bit WAV: pw-cat drains raw input
        from a file without pacing it) into the node `target`; returns the
        pw-cat process."""
        path = os.path.join(self.dir, "silence.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(channels)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(bytes(int(seconds * rate) * channels * 2))
        p = subprocess.Popen(["pw-cat", "--playback", "--target", target, path],
                             env=self.env, stdout=self.log, stderr=self.log)
        self.procs.append(p)
        return p

    @staticmethod
    def card_state(index):
        """(status fields, hw_params fields) of the card's first playback substream."""
        def fields(path):
            try:
                text = open(path).read()
            except OSError:
                return {}
            if text.strip() == "closed":
                return {"state": "closed"}
            return {k.strip(): v.strip() for k, v in (l.split(":", 1) for l in text.splitlines() if ":" in l)}
        base = f"/proc/asound/card{index}/pcm0p/sub0/"
        return fields(base + "status"), fields(base + "hw_params")

    def running(self, index, timeout=8):
        """Wait for the card to be RUNNING; its (status, hw_params), or None."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            st, hw = self.card_state(index)
            if st.get("state") == "RUNNING":
                return st, hw
            time.sleep(0.1)
        return None

    def close(self):
        for p in reversed(self.procs):
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    p.terminate()
                try:
                    p.wait(5)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
        self.log.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
