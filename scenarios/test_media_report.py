"""scripts/media_report.php, the Troubleshooting page's Media Files tab: run
with php-cli in the fppinit sandbox (fppinit.py), so the PipeWire
configuration it reads from /etc/pipewire/pipewire.conf.d is the scenario's
own and nothing reaches the machine's.

The scenario image has no ffprobe, so the sandbox gets a stand-in at
/usr/bin/ffprobe that reads a WAV file's header and prints what ffprobe's
JSON would say about it (codec, sample rate, channels, bits, duration). What
is checked is the report's judgement of the sample rates, not ffprobe."""

import os
import shlex
import wave

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture

CONFD = "/etc/pipewire/pipewire.conf.d"

FFPROBE = r"""#!/usr/bin/python3 -I
# Stand-in for ffprobe -print_format json -i FILE, for WAV files only.
import json, os, sys, wave
path = sys.argv[-1]
try:
    w = wave.open(path, "rb")
except Exception as e:
    sys.stderr.write("Invalid data found when processing input\n")
    sys.exit(1)
rate, ch, width, frames = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
dur = frames / rate
print(json.dumps({
    "streams": [{"index": 0, "codec_type": "audio", "codec_name": "pcm_s%dle" % (8 * width),
                 "sample_rate": str(rate), "channels": ch, "bits_per_sample": 8 * width,
                 "bit_rate": str(rate * ch * 8 * width), "duration": "%.6f" % dur}],
    "format": {"format_name": "wav", "duration": "%.6f" % dur,
               "size": str(os.path.getsize(path)), "bit_rate": str(rate * ch * 8 * width)},
}))
"""

# 90-fpp.conf as fpp ships it: the daemon default, which 95-fpp-alsa-sink.conf
# overrides when it names a rate.
DAEMON_CONF = """context.properties = {
    default.clock.rate          = 48000
    default.clock.allowed-rates = [ 44100 48000 96000 ]
}
"""


def sink_conf(engine, configured):
    """95-fpp-alsa-sink.conf as fppinit writes it (FPPINIT_Audio.cpp): the
    rate AudioFormat asked for as a "# configured rate:" tag, and the rate the
    card achieved as default.clock.rate."""
    return (f"# configured rate: {configured}\n"
            "context.properties = {\n"
            f"    default.clock.rate = {engine}\n"
            "}\n")


def write_wav(sb, name, rate):
    path = os.path.join(sb.media, "music", name)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(4 * rate // 10))  # 0.1 s of silence


def report(sb, engine, configured):
    """The full report for the sandbox's music directory, with the engine
    rate and the configured rate set in 95-fpp-alsa-sink.conf."""
    sb.root_file("/usr/bin/ffprobe", FFPROBE)
    sb.root_file(f"{CONFD}/90-fpp.conf", DAEMON_CONF)
    sb.root_file(f"{CONFD}/95-fpp-alsa-sink.conf", sink_conf(engine, configured))
    for d in ("music", "videos", "images"):
        os.makedirs(os.path.join(sb.media, d), exist_ok=True)
    args = " ".join(shlex.quote(f"--{d}={MEDIA}/{d}") for d in ("music", "videos", "images"))
    # short_open_tag: config.php needs it, and FPP_Install.sh turns it on.
    r = sb._run(["sh", "-c", f"php -d short_open_tag=1 /opt/fpp/scripts/media_report.php {args}"], timeout=120)
    out = r.stdout + r.stderr
    assert r.returncode == 0, f"media_report.php exited {r.returncode}:\n{out[-3000:]}"
    assert "FPP Media Report" in out, out[-3000:]
    assert "ffprobe is not installed" not in out, out[-3000:]
    return out


def file_note(out, name):
    """The Note column of a file's row in "Every audio file" ('' for none)."""
    rows = [l for l in out.split("Every audio file", 1)[1].splitlines() if l.startswith(name + " ")]
    assert len(rows) == 1, f"no single row for {name}:\n{out[-3000:]}"
    row = rows[0]
    for note in ("hardware upsample", "resampled"):
        if row.rstrip().endswith(note):
            return note
    return ""


def test_sample_rates_are_judged_against_the_configured_rate_too(fppinit):
    """With a card that refines the configured 44.1 kHz up to an 88.2 kHz
    engine rate, the report names both rates and sorts each file into one of
    three groups: a 44.1 kHz file is "hardware upsample" (the card doubles
    it) and is not counted as a file to convert; an 88.2 kHz file is at the
    engine rate, with no note; a 48 kHz file is resampled, and the advice is
    to convert it to 44.1 kHz, the configured rate, not 88.2 kHz. With the
    two rates the same (48 kHz) there is no configured-rate line and the
    44.1 kHz file is the one to convert, to 48 kHz (the control).

    Regression: 4aa9013a9. The report judged every file against the engine
    rate alone, so on such a board it called 44.1 kHz audio "resampled to
    88.2 kHz" and counted it as a file to convert."""
    sb = fppinit
    write_wav(sb, "a44.wav", 44100)
    write_wav(sb, "b48.wav", 48000)
    write_wav(sb, "c88.wav", 88200)

    out = report(sb, engine=88200, configured=44100)
    # One line per file: the three groups
    assert file_note(out, "a44.wav") == "hardware upsample", out
    assert file_note(out, "b48.wav") == "resampled", out
    assert file_note(out, "c88.wav") == "", out
    # The resampling summary counts only the 48 kHz file as one to convert
    assert "Audio files to convert to 44.1 kHz: 1 of 3 (33%)" in out, out
    assert ("Hardware upsample, not counted above: 1 audio file, 0 video soundtracks"
            " (at 44.1 kHz, upsampled by the hardware)") in out, out
    assert "At the engine rate (88.2 kHz): 1 audio file, 0 video soundtracks" in out, out
    assert "Convert these to 44.1 kHz, the configured rate, not 88.2 kHz, the engine rate." in out, out
    # The sample-rate table's notes
    assert "<-- hardware upsample (x2 to 88.2 kHz)" in out, out
    assert "<-- resampled; convert to 44.1 kHz" in out, out
    assert "resampled to 88.2 kHz" not in out, out
    # Both rates named, and the difference explained
    assert "Audio engine rate : 88.2 kHz  (95-fpp-alsa-sink.conf)" in out, out
    assert "Configured rate   : 44.1 kHz" in out, out
    assert "The audio engine runs at 88.2 kHz, not the 44.1 kHz configured." in out, out
    assert "88.2 kHz is the lowest rate this hardware supports (44.1 kHz configured)." in out, out
    assert "Resampling (engine 88.2 kHz, configured 44.1 kHz)" in out, out

    # Control: the card runs at the rate configured.
    out = report(sb, engine=48000, configured=48000)
    assert "Audio engine rate : 48 kHz  (95-fpp-alsa-sink.conf)" in out, out
    assert "Configured rate" not in out, out
    assert "The audio engine runs at" not in out, out
    assert "Hardware upsample" not in out and "hardware upsample" not in out, out
    assert "Resampling at 48 kHz" in out, out
    assert "Audio files to convert to 48 kHz: 2 of 3 (67%)" in out, out
    assert "Convert these to 48 kHz ahead of time so they are not resampled on every play." in out, out
    assert file_note(out, "a44.wav") == "resampled", out
    assert file_note(out, "b48.wav") == "", out
    assert file_note(out, "c88.wav") == "resampled", out


def test_a_file_at_the_configured_rate_on_a_card_stuck_elsewhere(fppinit):
    """With 44.1 kHz configured and a card that runs only at 48 kHz (not a
    whole multiple), the report says 48 kHz is the lowest rate the hardware
    supports and is not a whole multiple of 44.1 kHz. A 44.1 kHz file is
    counted on a line of its own, "already at 44.1 kHz but still resampled",
    rather than as a file to convert; a 32 kHz file is one to convert, to
    44.1 kHz.

    Regression: 4aa9013a9 (the "stuck" group). Before it, the 44.1 kHz file
    was counted as one to convert, which would change nothing."""
    sb = fppinit
    write_wav(sb, "a44.wav", 44100)
    write_wav(sb, "b48.wav", 48000)
    write_wav(sb, "d32.wav", 32000)

    out = report(sb, engine=48000, configured=44100)
    assert "Audio files to convert to 44.1 kHz: 1 of 3 (33%)" in out, out
    assert ("Already at 44.1 kHz but still resampled: 1 audio file, 0 video soundtracks"
            " (the hardware runs at 48 kHz, which is not a whole multiple, so converting"
            " them would not help)") in out, out
    assert "Hardware upsample" not in out, out
    assert "Configured rate   : 44.1 kHz" in out, out
    assert "48 kHz is the lowest rate this hardware supports (44.1 kHz configured)." in out, out
    assert ("48 kHz is not a whole multiple of 44.1 kHz, so audio at any rate other than"
            " 48 kHz is resampled on the CPU.") in out, out
    assert "<-- resampled to 48 kHz (not a multiple of 44.1 kHz)" in out, out
    assert "<-- resampled; convert to 44.1 kHz" in out, out
    assert file_note(out, "a44.wav") == "resampled", out
    assert file_note(out, "b48.wav") == "", out
    assert file_note(out, "d32.wav") == "resampled", out


def test_a_hardware_refined_rate_is_info_not_a_warning(fppinit):
    """When the engine rate differs from the configured one (an 88.2 kHz
    card with 44.1 kHz configured), the report notes it with a leading
    [INFO], which the Troubleshooting page shows muted and does not count
    as a warning, not [WARN].

    Regression: 30f9ceaf4. The line was a [WARN], so every device with such a
    cape showed its normal and only possible state as a fault."""
    sb = fppinit
    write_wav(sb, "a44.wav", 44100)
    out = report(sb, engine=88200, configured=44100)
    lines = out.splitlines()
    note = [l for l in lines if "The audio engine runs at 88.2 kHz, not the 44.1 kHz configured." in l]
    assert note == ["[INFO] The audio engine runs at 88.2 kHz, not the 44.1 kHz configured."], out
    assert not any(l.startswith("[WARN]") for l in lines), out


def test_the_report_marks_resampled_audio_and_the_summary_names_no_files(fppinit):
    """The full report lists every file, marks the 44.1 kHz one on a 48 kHz
    engine as resampled and counts it as one to convert; --summary, the form
    a Diagnostic Report gets (the command is "pii"), has the counts but no
    file names.

    Feature: c42fd987d (the Media Files tab's report)."""
    sb = fppinit
    write_wav(sb, "song-at-44k.wav", 44100)
    write_wav(sb, "song-at-48k.wav", 48000)
    out = report(sb, engine=48000, configured=48000)
    assert file_note(out, "song-at-44k.wav") == "resampled", out
    assert file_note(out, "song-at-48k.wav") == "", out
    assert "48 kHz: 1 of 2 (50%)" in out, out  # "Audio files to convert to" (was "not at")

    args = " ".join(shlex.quote(f"--{d}={MEDIA}/{d}") for d in ("music", "videos", "images"))
    r = sb._run(["sh", "-c", f"php -d short_open_tag=1 /opt/fpp/scripts/media_report.php --summary {args}"],
                timeout=120)
    summary = r.stdout + r.stderr
    assert r.returncode == 0, summary[-3000:]
    assert "48 kHz: 1 of 2 (50%)" in summary, summary
    assert "song-at-" not in summary, f"the summary names files:\n{summary}"
