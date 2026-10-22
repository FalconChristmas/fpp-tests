"""The hardware mixer fppd pins to unity under the PipeWire backend.

Runs anywhere: a stand-in amixer on fppd's PATH describes a PCM512x-style card
and records every level fppd writes, so no sound device is needed.
"""

import os
import stat
import tempfile

FAKE_AMIXER = r"""#!/bin/sh
# Stand-in for amixer: a PCM512x-like card. 'Digital' has a dB scale whose top
# is +24 dB (100% is not unity), 'Plain' is a volume with no dB scale, and
# 'DSP Program' is an enum fppd must not write.
while [ "$1" = "-c" ] || [ "$1" = "-D" ]; do shift 2; done
case "$1" in
scontrols)
    echo "Simple mixer control 'DSP Program',0"
    echo "Simple mixer control 'Digital',0"
    echo "Simple mixer control 'Plain',0"
    ;;
sget|get)
    case "$2" in
    Digital)
        echo "Simple mixer control 'Digital',0"
        echo "  Capabilities: pvolume pswitch"
        echo "  Limits: Playback 0 - 255"
        echo "  Front Left: Playback 255 [100%] [24.00dB] [on]"
        ;;
    Plain)
        echo "Simple mixer control 'Plain',0"
        echo "  Capabilities: pvolume"
        echo "  Limits: Playback 0 - 31"
        echo "  Front Left: Playback 31 [100%]"
        ;;
    *)
        echo "Simple mixer control '$2',0"
        echo "  Capabilities: enum"
        ;;
    esac
    ;;
sset|set)
    echo "$2 $3" >> "$FAKE_AMIXER_LOG"
    ;;
esac
exit 0
"""


def writes(log):
    """{control: [level, ...]} in the order fppd wrote them."""
    out = {}
    if os.path.exists(log):
        with open(log) as f:
            for line in f:
                name, _, level = line.strip().rpartition(" ")
                out.setdefault(name, []).append(level)
    return out


def test_volume_pins_db_controls_at_0db_not_100_percent(fppd, monkeypatch):
    """Setting the volume puts a control with a dB scale at 0 dB and leaves it
    there; 100% is written only to a control that has no dB scale.

    Regression: fppd decided whether "0dB" had worked from system()'s return,
    which is always -1 because fppd sets SA_NOCLDWAIT, so it followed every
    "0dB" with "100%". On a PCM512x that is +24 dB of digital gain: the card
    clipped, and a transmitter fed from it was overdriven by the same 24 dB.
    Fixed by 8b99e23d0. Feature: 1c563dcf7 (every playback volume control is
    pinned, not only the AudioMixerDevice one, which is unset here).
    """
    bindir = tempfile.mkdtemp(prefix="fakebin-")
    amixer = os.path.join(bindir, "amixer")
    with open(amixer, "w") as f:
        f.write(FAKE_AMIXER)
    os.chmod(amixer, os.stat(amixer).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    log = os.path.join(fppd.media, "tmp", "amixer.log")
    monkeypatch.setenv("FAKE_AMIXER_LOG", log)
    monkeypatch.setenv("PATH", bindir + os.pathsep + os.environ.get("PATH", ""))

    fppd.settings(MediaBackend="pipewire-simple", volume="70")
    fppd.start()
    fppd.post("/fppd/volume/50")
    fppd.wait_for(lambda: "Digital" in writes(log), timeout=10, interval=0.25,
                  what="fppd to set the card's mixer")

    w = writes(log)
    assert "DSP Program" not in w, f"fppd wrote an enum control: {w}"
    assert w["Digital"] and all(lv == "0dB" for lv in w["Digital"]), \
        f"a dB-scaled control must be pinned at 0dB, never 100% (+24 dB here): {w}"
    assert w.get("Plain") and w["Plain"][-1] == "100%", \
        f"a control with no dB scale should end at 100%: {w}"


def test_mixer_control_name_cannot_run_a_command(fppd, monkeypatch):
    """Under the ALSA backend a mixer control name holding a single quote
    is not handed to the shell: hardware volume is skipped, as for a
    missing control.

    Regression: 94cceb218 (as repaired by 937540369). The name was pasted
    between single quotes into an "amixer set" command run by system(), so
    "x'; touch FILE; echo '" ran the touch as root."""
    import time
    bindir = tempfile.mkdtemp(prefix="fakebin-")
    amixer = os.path.join(bindir, "amixer")
    with open(amixer, "w") as f:
        f.write(FAKE_AMIXER)
    os.chmod(amixer, os.stat(amixer).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("FAKE_AMIXER_LOG", os.path.join(fppd.media, "tmp", "amixer.log"))
    monkeypatch.setenv("PATH", bindir + os.pathsep + os.environ.get("PATH", ""))
    pwned = os.path.join(fppd.media, "tmp", "pwned")
    fppd.settings(MediaBackend="alsa", AudioMixerDevice=f"x'; touch {pwned}; echo '",
                  LogLevel_MediaOut="debug")
    fppd.start()
    fppd.post("/fppd/volume/50")
    fppd.wait_for(lambda: "contains a quote" in fppd.log() or "Setting ALSA hardware volume" in fppd.log(),
                  timeout=10, interval=0.25, what="fppd to apply the volume")
    time.sleep(1)
    assert not os.path.exists(pwned), "the mixer control name ran a shell command"
    assert "contains a quote; skipping" in fppd.log()
