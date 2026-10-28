"""The audio chain fppd builds for each backend: what happens when an element
of it can't be made, which sink it plays to, and how the sound reaches the
PipeWire graph (channel order, rate, the start of the file)."""

import os
import signal
import subprocess
import time
import urllib.error

import pytest

import shims
from show import playlist, status
from test_media_commands import slot_status
from test_video import MODEL, setup


def make_video(path, seconds=6, channels=4):
    """A VP8 Matroska file of SMPTE bars with a `channels`-channel Vorbis
    tone track. More than two channels keeps a video's sound off the slot's
    persistent output stream, on a pipewiresink of its own."""
    cmd = ["gst-launch-1.0", "-q", "matroskamux", "name=mux", "!", "filesink", f"location={path}",
           "videotestsrc", f"num-buffers={seconds * 10}", "pattern=smpte", "!",
           "video/x-raw,width=320,height=240,framerate=10/1", "!", "vp8enc", "deadline=1", "!", "mux.",
           "audiotestsrc", "volume=0.1", "samplesperbuffer=4410", f"num-buffers={seconds * 10}", "!",
           f"audio/x-raw,rate=44100,channels={channels}", "!", "audioconvert", "!", "vorbisenc", "!", "mux."]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode:
        pytest.skip(f"cannot make a test video (gst-launch-1.0): {r.stderr.strip()[-300:]}")


def test_an_audio_chain_missing_its_sink_is_refused(fppd, audio):
    """A video whose sound goes to a pipewiresink of its own (four
    channels), on an install where pipewiresink can't be made (nofactory.so):
    the media is refused with an error naming a missing plug-in, and the
    slot isn't left claiming to play.

    Regression: 7d16ef828. gst_bin_add_many() stops at the first NULL, so
    with no sink the rest of the audio chain was left out of the pipeline,
    every link after it failed, and the media played on with no sound and
    no error."""
    make_video(os.path.join(fppd.media, "videos", "Quad.mkv"))
    setup(fppd, [])
    fppd.start(preload=[shims.build("nofactory.c")])
    with pytest.raises(urllib.error.HTTPError) as refused:
        fppd.command("Play Media", "Quad.mkv", "1", "0", "1", MODEL)
    assert refused.value.code == 500, refused.value
    assert "could not create the audio chain (a GStreamer plugin is missing)" in fppd.log()
    time.sleep(1)
    s = slot_status(fppd, 1)
    assert not s or s.get("status") != "playing", f"the slot plays with no audio chain: {s}"
    assert status(fppd).get("status_name") == "idle", status(fppd).get("status_name")


def write_chirp_wav(path, seconds, channels, f0=200.0, rate_hz_per_s=1000.0, rate=48000, amplitude=0.5):
    """A linear chirp, f0 + rate_hz_per_s * t, the same in every one of
    `channels` channels: the frequency of any stretch of it says which
    moment of the file it came from."""
    import array
    import math
    import wave
    n = int(seconds * rate)
    mono = array.array("h", (int(amplitude * 32767 * math.sin(2 * math.pi * (f0 * (i / rate) + rate_hz_per_s / 2 * (i / rate) ** 2)))
                             for i in range(n)))
    pcm = array.array("h", bytes(2 * n * channels))
    for c in range(channels):
        pcm[c::channels] = mono
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return path


def chirp_time(samples, start, rate=48000, f0=200.0, rate_hz_per_s=1000.0, window_s=0.02):
    """The moment of the chirp the window of `samples` from `start` came
    from, by its zero crossings."""
    w = samples[start:start + int(window_s * rate)]
    crossings = [i for i in range(1, len(w)) if (w[i - 1] < 0) != (w[i] < 0)]
    if len(crossings) < 3:
        return None
    freq = (len(crossings) - 1) / 2 / ((crossings[-1] - crossings[0]) / rate)
    return (freq - f0) / rate_hz_per_s


def test_a_multichannel_audio_file_is_heard_from_its_start(fppd, audio):
    """Play Media of a four-channel audio file (too many channels for the
    slot's persistent output stream, so it plays to a pipewiresink of its
    own) through the PipeWire backend: the first sound on the sink is the
    file's first moments, under 100 ms in, not a quarter-second later.

    Regression: 9db1a6431. Every pipeline was put on the system clock; for
    an audio-only one that clock was already running while pipewiresink's
    stream came up, so what was rendered meanwhile was late and dropped:
    240-280 ms of the head of every file were lost.

    Also covers 8e1e9c23c: with the pipewiresink's stream-properties
    written inline in the gst_parse_launch description, the node
    description's spaces ("FPP Media Stream 1") made the parse fail ("could
    not set property stream-properties"), and Play Media of any file that
    needs a pipewiresink of its own failed."""
    write_chirp_wav(os.path.join(fppd.media, "music", "Chirp.wav"), 4, 4)
    fppd.start()
    losses = []
    for _ in range(3):
        rec = audio.record()
        # Hold WirePlumber for 0.4 s so the stream is linked late, as on a
        # busy single-core board: until then pipewiresink's stream is up
        # but not running.
        wireplumber = audio.procs[1]
        os.kill(wireplumber.pid, signal.SIGSTOP)
        try:
            fppd.command("Play Media", "Chirp.wav", "1", "0", "1")
            time.sleep(0.4)
        finally:
            os.kill(wireplumber.pid, signal.SIGCONT)
        fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") == "playing", timeout=10,
                      what="the chirp to play")
        fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") != "playing", timeout=15,
                      what="the chirp to end")
        samples = rec.stop()
        first = next((i for i, x in enumerate(samples) if abs(x) > 0.05), None)
        assert first is not None, "nothing was heard"
        losses.append(chirp_time(samples, first))
    # The median of three: now and then the recording itself is linked
    # late and hears only the end of a play.
    lost = sorted(t if t is not None else 99 for t in losses)[1]
    assert lost < 0.1, f"{lost:.2f} s of the head of the file was lost (each play: {losses})"


def stream_formats(audio):
    """{node name: negotiated rate} for every playback stream on the graph."""
    import json
    dump = json.loads(subprocess.run(["pw-dump"], env=audio.env, capture_output=True, text=True).stdout or "[]")
    out = {}
    for o in dump:
        info = o.get("info") or {}
        props = info.get("props") or {}
        if o.get("type") != "PipeWire:Interface:Node" or props.get("media.class") != "Stream/Output/Audio":
            continue
        for f in (info.get("params") or {}).get("Format") or []:
            out[props.get("node.name")] = f.get("rate")
    return out


@pytest.fixture
def graph44(fppd):
    """The audio fixture's PipeWire with its graph clock at 44.1 kHz, as on
    an I2S cape or most USB cards."""
    import shutil
    from audio import SINK, AudioServer
    if not shutil.which("pipewire") or not shutil.which("wireplumber"):
        pytest.skip("PipeWire and WirePlumber are not installed")
    server = AudioServer(rate=44100)
    fppd.settings(MediaBackend="pipewire-simple", PipeWireSinkName=SINK, volume="100")
    try:
        yield server
    finally:
        server.close()


def test_audio_reaches_a_44k1_graph_at_the_graph_rate(fppd, graph44):
    """On a 44.1 kHz graph, a four-channel file (one that plays to a
    pipewiresink of its own) reaches PipeWire at 44100 Hz: a 44.1 kHz file
    as it is, and an 88.2 kHz one brought down to the graph's rate, never
    48000. Both are heard.

    Regression: aaa630d1b. The pipeline pinned 48000 Hz before the sink,
    so audioresample took a 44.1 kHz file up to 48000 and PipeWire's
    adapter took it straight back down -- a quarter of a single-core
    board's CPU; at twice the graph rate or more the graph's own rate is
    now pinned instead, from the live daemon's clock."""
    for name, rate in (("CD.wav", 44100), ("Hi.wav", 88200)):
        write_chirp_wav(os.path.join(fppd.media, "music", name), 6, 4, rate=rate)
    fppd.start()
    for name in ("CD.wav", "Hi.wav"):
        rec = graph44.record(rate=44100)
        fppd.command("Play Media", name, "1", "0", "1")
        fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") == "playing", timeout=10,
                      what=f"{name} to play")
        formats = fppd.wait_for(lambda: stream_formats(graph44) or None, timeout=10,
                                what=f"fppd's stream for {name} on the graph")
        time.sleep(2)
        fppd.command("Stop All Media")
        fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") != "playing", timeout=10,
                      what=f"{name} to stop")
        heard = sum(1 for x in rec.stop() if abs(x) > 0.05)
        assert set(formats.values()) == {44100}, f"{name} reached the graph at {formats}, not 44100"
        assert heard > 44100 // 2, f"{name} was hardly heard ({heard} loud samples)"


SURROUND = ["FL", "FR", "FC", "LFE", "RL", "RR"]
PULSE_NAMES = {"FL": "front-left", "FR": "front-right", "FC": "front-center", "LFE": "lfe",
               "RL": "rear-left", "RR": "rear-right", "MONO": "mono"}
# One tone per channel of the file, in WAV order.
TONES = [300, 500, 700, 900, 1100, 1300]


def write_tones_wav(path, seconds, freqs, rate=48000, amplitude=0.4):
    """A WAV of len(freqs) channels, channel i a steady tone at freqs[i]
    (WAV order: FL FR FC LFE RL RR for six)."""
    import array
    import math
    import wave
    n = int(seconds * rate)
    pcm = array.array("h", bytes(2 * n * len(freqs)))
    for c, f in enumerate(freqs):
        step = 2 * math.pi * f / rate
        pcm[c::len(freqs)] = array.array("h", (int(amplitude * 32767 * math.sin(step * i)) for i in range(n)))
    with wave.open(path, "wb") as w:
        w.setnchannels(len(freqs))
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return path


def add_sink(audio, name, positions):
    """A null sink of the given channel positions on the fixture's
    PipeWire, through pipewire-pulse."""
    channel_map = ",".join(PULSE_NAMES[p] for p in positions)
    subprocess.run(["pactl", "load-module", "module-null-sink", f"sink_name={name}",
                    f"channels={len(positions)}", f"channel_map={channel_map}", "rate=48000"],
                   env=audio.env, check=True, capture_output=True, timeout=10)
    deadline = time.monotonic() + 10
    while name not in subprocess.run(["pw-cli", "ls", "Node"], env=audio.env, capture_output=True,
                                     text=True).stdout:
        assert time.monotonic() < deadline, f"the {name} sink never appeared"
        time.sleep(0.2)


class ChannelRecording:
    """What is played into `sink` from now until stop(), one list of
    samples per channel position."""

    def __init__(self, audio, sink, positions):
        import tempfile
        self.positions = positions
        self.path = tempfile.mktemp(suffix=".wav")
        self.proc = subprocess.Popen(
            ["pw-record", "--target", sink, "-P", "stream.capture.sink=true", "-P", "stream.dont-remix=true",
             "--rate", "48000", "--channels", str(len(positions)), "--channel-map", ",".join(positions),
             "--format", "s16", self.path],
            env=audio.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)

    def stop(self):
        import struct
        import wave
        self.proc.terminate()
        self.proc.wait(5)
        with wave.open(self.path) as w:
            n = w.getnchannels()
            data = w.readframes(w.getnframes())
        os.unlink(self.path)
        samples = struct.unpack(f"<{len(data) // 2}h", data)
        return {p: [x / 32768 for x in samples[i::n]] for i, p in enumerate(self.positions)}


def tone_level(samples, freq, rate=48000):
    """The amplitude of `freq` in `samples` (Goertzel), over their last
    second."""
    import math
    s = samples[-rate:]
    if not s:
        return 0.0
    k = 2 * math.cos(2 * math.pi * freq / rate)
    a = b = 0.0
    for x in s:
        a, b = x + k * a - b, a
    return 2 * math.sqrt(max(a * a + b * b - k * a * b, 0.0)) / len(s)


def heard_tones(channels):
    """{position: the file's tone loudest on it, or None if none is}."""
    out = {}
    for pos, samples in channels.items():
        levels = {f: tone_level(samples, f) for f in TONES}
        best = max(levels, key=levels.get)
        out[pos] = best if levels[best] > 0.05 else None
    return out


def test_each_channel_of_a_5_1_file_reaches_its_own_speaker(fppd, audio):
    """A 5.1 file with a different tone on each channel, played with Play
    Media to a 5.1 sink through the PipeWire backend: every tone arrives on
    the sink channel of the same name -- the centre and LFE tones on FC and
    LFE, the rear ones on RL and RR.

    Regression: 01eb399d6. pipewiresink (gst-pipewire 1.4.2, the one
    installed here) declares 5.1 in PulseAudio order, FL FR RL RR FC LFE,
    while the samples stay in WAV order, so PipeWire's position-matched
    links put the centre and LFE on the rear speakers and the rear channels
    on centre and LFE. fppd now probes the plugin and pre-permutes."""
    add_sink(audio, "fpp_test_51", SURROUND)
    fppd.settings(PipeWireSinkName="fpp_test_51")
    write_tones_wav(os.path.join(fppd.media, "music", "Six.wav"), 6, TONES)
    fppd.start()
    rec = ChannelRecording(audio, "fpp_test_51", SURROUND)
    fppd.command("Play Media", "Six.wav", "1", "0", "1")
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") == "playing", timeout=10,
                  what="the 5.1 file to play")
    time.sleep(3)
    heard = heard_tones(rec.stop())
    want = dict(zip(SURROUND, TONES))
    assert heard == want, f"tones by sink channel: {heard}, want {want}"


# file channels, sink positions, {sink position: tones that must reach it}
FOLD_DOWNS = {
    # A pipewiresink of its own: centre and LFE to both sides, each rear to its side.
    "5.1-on-stereo": (6, ["FL", "FR"], {"FL": [300, 700, 900, 1100], "FR": [500, 700, 900, 1300]}),
    # The slot's persistent output stream.
    "stereo-on-mono": (2, ["MONO"], {"MONO": [300, 500]}),
}


@pytest.mark.parametrize("case", list(FOLD_DOWNS))
def test_a_file_with_more_channels_than_the_sink_is_folded_down(fppd, audio, case):
    """A file with more channels than its sink -- 5.1 on a stereo sink, and
    stereo on a mono one -- played with Play Media through the PipeWire
    backend: every channel of the file is heard, folded into the sink's.

    Regression: a72c78faa. d2dbc0aca gave fppd's streams stream.dont-remix
    and channelmix.disable, as booleans, which PipeWire reads as false: they
    never applied. Set as the strings it honours, they cut a 5.1 file on a
    stereo sink to its front left and right -- no centre, LFE or rears --
    and a stereo file on a mono sink to its left channel. They are gone;
    channel order on a surround sink is the pre-permute's job (01eb399d6).
    The control: a72c78faa's parent with the props passed as strings goes
    red on both cases."""
    channels, positions, want = FOLD_DOWNS[case]
    add_sink(audio, "fpp_test_fold", positions)
    fppd.settings(PipeWireSinkName="fpp_test_fold")
    write_tones_wav(os.path.join(fppd.media, "music", "Fold.wav"), 6, TONES[:channels])
    fppd.start()
    rec = ChannelRecording(audio, "fpp_test_fold", positions)
    fppd.command("Play Media", "Fold.wav", "1", "0", "1")
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") == "playing", timeout=10,
                  what="the file to play")
    time.sleep(3)
    channels_heard = rec.stop()
    levels = {p: {f: round(tone_level(channels_heard[p], f), 3) for f in TONES[:channels]} for p in positions}
    missing = {p: [f for f in fs if levels[p][f] < 0.05] for p, fs in want.items()}
    assert not any(missing.values()), f"tones missing by sink channel: {missing}; levels {levels}"



def test_a_multichannel_file_fades_in_instead_of_starting_at_full_level(fppd, audio):
    """Play Media of a four-channel steady tone (a pipewiresink of its own)
    through the PipeWire backend: the sound comes in over its first few
    tens of milliseconds, its first 5 ms well under the tone's full level,
    so a sink's start-up transient isn't met by a full-scale step.

    Regression: 4aa996ba0. The volume element started at the target level,
    so the first buffer hit the sink at full scale -- an audible click on
    USB and I2S outputs as they came up. Not covered: the 250 ms of silence
    flushed through the graph at Stop, which only shows on a filter-chain or
    combine node holding stale audio."""
    write_tones_wav(os.path.join(fppd.media, "music", "Quad.wav"), 4, [1000] * 4)
    fppd.start()
    rises = []
    for _ in range(3):
        rec = audio.record()
        fppd.command("Play Media", "Quad.wav", "1", "0", "1")
        fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") == "playing", timeout=10,
                      what="the tone to play")
        time.sleep(1.5)
        fppd.command("Stop All Media")
        fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") != "playing", timeout=10,
                      what="the tone to stop")
        samples = rec.stop()
        # Let the stopped stream go before the next recording starts, so
        # it doesn't hear this one's tail.
        time.sleep(1)
        first = next((i for i, x in enumerate(samples) if abs(x) > 0.01), None)
        assert first is not None, "nothing was heard"
        n = 48000 * 5 // 1000
        steady = max(abs(x) for x in samples[first + 48000 * 3 // 10:first + 48000])
        head = max(abs(x) for x in samples[first:first + n])
        rises.append(round(head / steady, 2))
    # The median of three plays, as the recording is now and then linked late.
    assert sorted(rises)[1] < 0.6, f"the first 5 ms came in at {rises} of the tone's level"


class AlsaFile:
    """A default ALSA device for fppd that writes what it is given to a
    file: 48 kHz stereo S16, through a plug that converts to that, over the
    null PCM. With no PipeWire running, as on a box left on the ALSA media
    backend."""

    def __init__(self, fppd):
        self.raw = os.path.join(fppd.media, "tmp", "alsa-out.raw")
        self.conf = os.path.join(fppd.media, "tmp", "alsa-file.conf")
        os.makedirs(os.path.dirname(self.raw), exist_ok=True)
        with open(self.conf, "w") as f:
            f.write(f'pcm.fpptestfile {{ type file slave.pcm "null" file "{self.raw}" format "raw" }}\n'
                    'pcm.!default { type plug slave { pcm "fpptestfile" format S16_LE rate 48000 channels 2 } }\n')
        fppd.settings(MediaBackend="alsa", AudioBackend="alsa")
        self.env = {"ALSA_CONFIG_PATH": "/usr/share/alsa/alsa.conf:" + self.conf}
        self.preload = [shims.build("alsapace.c", libs=("-ldl", "-lasound"))]

    def samples(self):
        """The left channel of everything written so far."""
        import struct
        try:
            with open(self.raw, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            return []
        data = data[:len(data) // 4 * 4]
        return [x / 32768 for x in struct.unpack(f"<{len(data) // 2}h", data)[0::2]]


@pytest.fixture
def alsa(fppd):
    return AlsaFile(fppd)


def test_the_alsa_backend_plays_to_alsa_whatever_pipewire_sink_is_set(fppd, alsa):
    """On the ALSA media backend, with a PipeWire sink name still in the
    settings from before and no PipeWire running, Play Media of a stereo
    tone reaches the ALSA device: the tone is written to it.

    Regression: 12052a3f4. The PipeWire sink name was used whatever the
    backend, so the pipeline was built on a pipewiresink aimed at a
    PipeWire that isn't there, and nothing played."""
    from audio import write_tone_wav
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 3, freq=1000)
    fppd.settings(PipeWireSinkName="fpp_group_left_over")
    fppd.start(extra_env=alsa.env, preload=alsa.preload)
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    fppd.wait_for(lambda: sum(1 for x in alsa.samples() if abs(x) > 0.1) > 24000, timeout=15,
                  what="the tone to reach the ALSA device")
    assert tone_level(alsa.samples(), 1000) > 0.1, "what reached ALSA isn't the tone"


def test_a_video_on_the_alsa_backend_ignores_the_pipewire_video_sink(fppd, alsa):
    """On the ALSA media backend, with PipeWireVideoSinkName left in the
    settings and no PipeWire running, Play Media of a video to HDMI-A-1
    (nothing connected) plays its sound to the ALSA device and ends: the
    status goes idle again. (Not on time: an ASan fppd on CI has taken 11 s
    over a 4 s video, idle 6 s after its sound had all been written.)

    Regression: ffe8246a5. The PipeWire video sink was honoured on the ALSA
    backend, so the video pipeline was built to feed a pipewiresink with no
    PipeWire to connect to, and playback stalled."""
    import test_video
    test_video.make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=4)
    fppd.settings(PipeWireVideoSinkName="fpp_video_bus", VideoOutput="HDMI-A-1")
    fppd.start(extra_env=alsa.env, preload=alsa.preload)
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: sum(1 for x in alsa.samples() if abs(x) > 0.02) > 24000, timeout=10,
                  what="the video's sound to reach the ALSA device")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20, interval=0.2,
                  what="the video to end")


def test_the_alsa_backend_starts_without_waiting_on_a_sound_server(fppd, alsa):
    """On the ALSA media backend, with a PulseAudio server that never
    answers in the environment (as a socket-activated pipewire-pulse whose
    daemon doesn't come up), Play Media's sound reaches the ALSA device
    within two seconds of the command.

    Regression: be483756f. The sink was autoaudiosink, which tries the
    higher-ranked pulsesink first; it sat waiting on the server before
    falling back to ALSA, so every track started late."""
    import socket
    import threading
    from audio import write_tone_wav
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    held = []

    def hold():
        while True:
            try:
                held.append(listener.accept()[0])
            except OSError:
                return
    threading.Thread(target=hold, daemon=True).start()
    try:
        write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 4, freq=1000)
        env = dict(alsa.env, PULSE_SERVER=f"tcp:127.0.0.1:{listener.getsockname()[1]}")
        fppd.start(extra_env=env, preload=alsa.preload)
        started = time.monotonic()
        fppd.command("Play Media", "Tone.wav", "1", "0", "1")
        fppd.wait_for(lambda: sum(1 for x in alsa.samples() if abs(x) > 0.1) > 4800, timeout=30,
                      interval=0.1, what="the tone to reach the ALSA device")
        took = time.monotonic() - started
        assert took < 2, f"the tone reached ALSA {took:.1f} s after Play Media"
    finally:
        listener.close()
        for c in held:
            c.close()


def test_with_no_sink_named_media_plays_to_pipewires_default(fppd, audio):
    """On the PipeWire backend with PipeWireSinkName empty, Play Media of a
    four-channel tone (a pipewiresink of its own) is heard on PipeWire's
    default sink -- the only one there is.

    Regression: 856acf5f1. With no sink named the pipeline fell through to
    the ALSA sink, which on a PipeWire box finds no free device, so nothing
    was heard."""
    fppd.settings(PipeWireSinkName="")
    write_tones_wav(os.path.join(fppd.media, "music", "Quad.wav"), 4, [1000] * 4)
    fppd.start()
    rec = audio.record()
    fppd.command("Play Media", "Quad.wav", "1", "0", "1")
    time.sleep(3)
    samples = rec.stop()
    assert tone_level(samples, 1000) > 0.1, "the tone wasn't heard on the default sink"


def links(audio):
    """[(output node name, input node name)] for every link on the graph."""
    import json
    dump = json.loads(subprocess.run(["pw-dump"], env=audio.env, capture_output=True, text=True).stdout or "[]")
    names = {o["id"]: ((o.get("info") or {}).get("props") or {}).get("node.name")
             for o in dump if o.get("type") == "PipeWire:Interface:Node"}
    return [(names.get(o["info"]["output-node-id"]), names.get(o["info"]["input-node-id"]))
            for o in dump if o.get("type") == "PipeWire:Interface:Link"]


@pytest.mark.parametrize("hook", [True, False], ids=["with_hook", "without_hook"])
def test_a_group_output_waits_for_its_target_instead_of_the_default_sink(fppd, hook):
    """With the tree's WirePlumber linking hook loaded (etc/wireplumber), an
    output group's combine-stream output whose target sink isn't there yet
    is left unlinked -- not linked to the default sink, which would play the
    group's audio a second time -- and is linked to its target once that
    appears.

    Regression: 98b618455 (the hook). Without it WirePlumber fell back to
    the default sink for a combine output whose target it couldn't find.
    The without_hook case is the control: the same graph with no hook
    links the group to the default sink."""
    import shutil
    from audio import SINK, AudioServer, write_tone_wav
    if not shutil.which("pipewire") or not shutil.which("wireplumber"):
        pytest.skip("PipeWire and WirePlumber are not installed")
    server = AudioServer(wireplumber_from=os.path.join(fppd.tree, "etc", "wireplumber") if hook else None)
    player = None
    try:
        tone = write_tone_wav(os.path.join(fppd.media, "tmp", "Tone.wav"), 30, amplitude=0.1)
        player = subprocess.Popen(["pw-play", "--target", "fpp_alsa_late", "-P",
                                   '{ node.name = "output.fpp_group_test" }', tone],
                                  env=server.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3)
        early = [l for l in links(server) if l[0] == "output.fpp_group_test"]
        if not hook:
            assert ("output.fpp_group_test", SINK) in early, f"control: no fallback link to the default sink: {early}"
            return
        assert not early, f"the group output was linked before its target existed: {early}"
        add_sink(server, "fpp_alsa_late", ["FL", "FR"])
        deadline = time.monotonic() + 10
        while ("output.fpp_group_test", "fpp_alsa_late") not in links(server):
            assert time.monotonic() < deadline, f"never linked to its target: {links(server)}"
            time.sleep(0.25)
        assert ("output.fpp_group_test", SINK) not in links(server)
    finally:
        if player:
            player.terminate()
            player.wait(5)
        server.close()


def test_a_playing_track_is_asked_its_duration_about_once_a_second(fppd, audio):
    """While a playlist's song plays, fppd asks the pipeline for its duration about
    once a second (countdurquery.so counts the calls): over 6 s of a song,
    no more than 15 times.

    Regression: 43533bc63. The duration was queried on every 10 ms main
    loop tick; the pipeline-wide query walks every sink back to the parser,
    which stats the file each time -- most of the main loop's CPU on a
    single-core board. Not covered: the decoder offered F32 first, and the
    WLED sample tap dropping its buffers while nothing reads them."""
    from audio import write_tone_wav
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 20)
    fppd.write("playlists/Song.json", playlist("Song", [
        {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Tone.wav"}]))
    counter = os.path.join(fppd.media, "tmp", "durqueries")
    os.makedirs(os.path.dirname(counter), exist_ok=True)
    fppd.start(preload=[shims.build("countdurquery.c")], extra_env={"COUNTDURQUERY_FILE": counter})

    def count():
        try:
            with open(counter) as f:
                return int(f.read().strip() or 0)
        except (FileNotFoundError, ValueError):
            return 0
    fppd.command("Start Playlist", "Song", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("current_song") == "Tone.wav", timeout=10,
                  what="the playlist's song to play")
    time.sleep(1)
    before = count()
    time.sleep(6)
    asked = count() - before
    assert asked <= 15, f"the duration was queried {asked} times in 6 s of playback"
