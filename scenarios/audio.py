"""A PipeWire of the scenario's own, with a null sink that a test can record.

fppd's media goes through PipeWire on a device (MediaBackend pipewire-simple:
GStreamer -> pipewiresink -> /run/pipewire-fpp). This runs the same daemons
there -- pipewire, wireplumber to link streams, pipewire-pulse for the pactl
calls fppd makes -- with one null audio sink instead of a sound card, so it
works in a container or a namespace with no /dev/snd, and pw-record captures
exactly what fppd played.
"""

import math
import os
import shutil
import struct
import subprocess
import tempfile
import time
import wave

RUNTIME = "/run/pipewire-fpp"
SINK = "fpp_test_sink"
RATE = 48000

SINK_CONF = f"""
context.objects = [
  {{ factory = adapter
    args = {{ factory.name = support.null-audio-sink
             node.name = "{SINK}" node.description = "fpp-tests null sink"
             media.class = "Audio/Sink" audio.position = [ FL FR ] audio.rate = {RATE}
             monitor.channel-volumes = true }} }}
]
"""


def env():
    e = dict(os.environ)
    e.update(PIPEWIRE_RUNTIME_DIR=RUNTIME, XDG_RUNTIME_DIR=RUNTIME)
    return e


class AudioServer:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="pipewire-")
        os.makedirs(os.path.join(self.dir, "pipewire", "pipewire.conf.d"))
        with open(os.path.join(self.dir, "pipewire", "pipewire.conf.d", "50-fpp-tests-sink.conf"), "w") as f:
            f.write(SINK_CONF)
        os.makedirs(RUNTIME, exist_ok=True)
        self.env = env()
        self.env["XDG_CONFIG_HOME"] = self.dir
        # WirePlumber saves every node's volume under XDG_STATE_HOME and
        # restores it when the node reappears: shared (in $HOME), a volume one
        # scenario set -- POST /fppd/volume/50 leaves the sink at 0.125 -- was
        # the next scenario's starting level, and it heard nothing.
        self.env["XDG_STATE_HOME"] = os.path.join(self.dir, "state")
        self.procs = []
        log = open(os.path.join(self.dir, "daemons.log"), "w")
        for cmd in (["pipewire"], ["wireplumber"], ["pipewire-pulse"]):
            self.procs.append(subprocess.Popen(cmd, env=self.env, stdout=log, stderr=log,
                                               start_new_session=True))
            time.sleep(0.5)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            out = subprocess.run(["pw-cli", "ls", "Node"], env=self.env, capture_output=True, text=True).stdout
            if SINK in out:
                return
            time.sleep(0.25)
        self.close()
        raise RuntimeError("the PipeWire null sink never appeared; see " + log.name)

    def record(self, rate=RATE):
        return Recording(self.env, rate=rate)

    unity = True  # the null sink plays at unity gain

    def close(self):
        for p in reversed(self.procs):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(5)
                except subprocess.TimeoutExpired:
                    p.kill()
        shutil.rmtree(self.dir, ignore_errors=True)


class HostAudio:
    """The device's own PipeWire and sound card (run-local.sh --host-audio).
    fppd plays to the sink the device is configured for; the recording taps
    the card's own sink, so its samples run on the card's clock."""

    unity = False  # the device's volume applies

    def __init__(self):
        self.env = env()
        settings = {}
        with open("/home/fpp/media/settings") as f:
            for line in f:
                if "=" in line:
                    k, v = line.split("=", 1)
                    settings[k.strip()] = v.strip().strip('"')
        self.sink = settings.get("PipeWireSinkName") or "fpp_group_default"
        self.volume = settings.get("volume") or "70"
        sinks = subprocess.run(["pactl", "list", "short", "sinks"], env=self.env,
                               capture_output=True, text=True).stdout
        cards = [line.split("\t")[1] for line in sinks.splitlines() if "\tfpp_alsa_" in line]
        if not cards:
            raise RuntimeError("no fpp_alsa_* sink on the device's PipeWire:\n" + sinks)
        self.card_sink = cards[0]

    def record(self, rate=RATE):
        return Recording(self.env, self.card_sink, rate=rate)

    def close(self):
        pass


class Recording:
    """Everything played into a sink from now until stop(), as mono float
    samples, with the monotonic time the capture began. The samples are
    counted on the sink's clock: for a real card, the card's crystal."""

    def __init__(self, env, sink=SINK, rate=RATE):
        self.rate = rate
        self.path = tempfile.mktemp(suffix=".wav")
        self.proc = subprocess.Popen(
            ["pw-record", "--target", sink, "-P", "stream.capture.sink=true",
             "--rate", str(rate), "--channels", "1", "--format", "s16", self.path],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.started = time.monotonic()
        time.sleep(0.5)

    def stop(self):
        self.proc.terminate()
        self.proc.wait(5)
        with wave.open(self.path) as w:
            data = w.readframes(w.getnframes())
        os.unlink(self.path)
        n = len(data) // 2
        return [x / 32768 for x in struct.unpack(f"<{n}h", data)]


def rms_windows(samples, window_s=0.05):
    """(start time in s, RMS) for each window of the recording."""
    n = int(RATE * window_s)
    return [(i / RATE, math.sqrt(sum(x * x for x in samples[i:i + n]) / n))
            for i in range(0, len(samples) - n + 1, n)]


def write_tone_wav(path, seconds, freq=1000, amplitude=0.5, bursts=None):
    """A 48 kHz mono 16-bit tone. bursts: [(start_s, length_s)] makes the
    tone sound only in those stretches, silence elsewhere. Only the sounding
    samples are computed, so a long file of short bursts is quick to make
    even on a single-core board."""
    import array
    total = int(seconds * RATE)
    pcm = array.array("h", bytes(2 * total))
    spans = [(0, total)] if bursts is None else \
        [(int(s * RATE), min(total, int((s + l) * RATE))) for s, l in bursts]
    step = 2 * math.pi * freq / RATE
    scale = amplitude * 32767
    for start, end in spans:
        for i in range(start, end):
            pcm[i] = int(scale * math.sin(step * i))
    if pcm.itemsize != 2 or array.array("h", [1]).tobytes() != b"\x01\x00":
        pcm.byteswap()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return path


def card_position():
    """(hw_ptr, tstamp in s, path, nominal rate) for the running playback stream of the
    first card that has one, from /proc/asound -- the card's own position
    in frames and the system time ALSA last updated it. Two of these give
    the card's real rate against the system clock. None if no card runs."""
    import glob
    for path in sorted(glob.glob("/proc/asound/card*/pcm*p/sub*/status")):
        try:
            text = open(path).read()
        except OSError:
            continue
        if "state: RUNNING" not in text:
            continue
        fields = {}
        for line in text.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fields[k.strip()] = v.strip()
        try:
            hw = int(fields["hw_ptr"])
            sec, nsec = fields["tstamp"].split(".")
            return hw, int(sec) + int(nsec) / 1e9, path, card_rate(path)
        except (KeyError, ValueError):
            continue
    return None


def card_rate(path):
    """The card's nominal rate from its hw_params, or None."""
    try:
        for line in open(path.replace("/status", "/hw_params")):
            if line.startswith("rate:"):
                return int(line.split()[1])
    except OSError:
        pass
    return None
