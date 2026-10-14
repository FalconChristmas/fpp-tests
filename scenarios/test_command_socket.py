"""fppd's local command socket (/run/fppd/FPPD) and the `fpp` CLI that talks
to it.

The web UI's PHP sends this socket a handful of commands (SetSetting,
volume, test mode, log level, schedule reload, sequence start/pause/step/
stop), scripts/fppd_stop runs `fpp -q`, and the reset page runs `fpp -r`.
Each datagram is one comma-separated command; fppd answers on the sender's
own socket, or with an empty datagram for the commands that have nothing to
say.
"""

import os
import socket
import subprocess
import tempfile
import time

import pytest

from fseq import write_fseq, unique_frames
from show import status

SERVER = "/run/fppd/FPPD"


def send(cmd, timeout=5, reply=True):
    """Send one command datagram and return fppd's reply as text (None
    without waiting for one, for a datagram fppd doesn't answer)."""
    path = tempfile.mktemp(prefix="fpp-test-client-", dir="/run/fppd")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    try:
        s.bind(path)
        s.settimeout(timeout)
        s.sendto(cmd if isinstance(cmd, bytes) else cmd.encode(), SERVER)
        return s.recv(4096).decode(errors="replace") if reply else None
    finally:
        s.close()
        os.unlink(path)


def fpp(fppd, *args, timeout=15):
    """Run the `fpp` CLI built alongside this fppd; return (rc, stdout)."""
    r = subprocess.run([os.path.join(fppd.tree, "src", "fpp"), *args], capture_output=True,
                       text=True, timeout=timeout,
                       env=dict(os.environ, LD_LIBRARY_PATH=os.path.join(fppd.tree, "src")))
    return r.returncode, r.stdout


def fields(reply):
    """The "mode,result,message,..." reply split into its fields."""
    return reply.rstrip("\n").split(",")


def test_set_setting_takes_effect_at_once(fppd):
    """SetSetting changes the running value, and an empty value clears it
    (the UI clears settings that way: "SetSetting,name,,")."""
    fppd.start()
    send("SetSetting,TimeFormat,%Y,")
    year = time.strftime("%Y")
    fppd.wait_for(lambda: status(fppd)["timeStr"] == year, timeout=5,
                  what="TimeFormat %Y to show in the status")
    send("SetSetting,TimeFormat,,")
    fppd.wait_for(lambda: status(fppd)["timeStr"] != year, timeout=5,
                  what="the cleared TimeFormat to fall back")


def test_volume(fppd):
    fppd.start()
    reply = fields(send("v,37,"))
    assert reply[1] == "1" and reply[2] == "Setting Volume", reply
    assert fppd.get("/fppd/volume")["volume"] == 37
    assert fields(send("v"))[2] == "Invalid Volume"


def test_test_mode_round_trip(fppd):
    """SetTestMode turns the channel tester on with a JSON config,
    GetTestMode returns it, and an "enabled": 0 config turns it off."""
    fppd.start()
    on = '{"enabled":1,"mode":"SingleChase","subMode":"RGBChase-RGB","cycleMS":500,"colorPattern":"FF000000FF000000FF","channelSet":"1-30","channelSetType":"channelRange"}'
    assert "Test Mode Activated" in send("SetTestMode," + on)
    got = send("GetTestMode")
    assert '"enabled"' in got and '"SingleChase"' in got.replace(" ", ""), got
    assert status(fppd).get("status_name") == "testing"
    assert "Test Mode Deactivated" in send('SetTestMode,{"enabled":0}')
    fppd.wait_for(lambda: status(fppd).get("status_name") != "testing", timeout=5,
                  what="test mode to end")


def test_sequence_start_pause_step_stop(fppd):
    """The UI's sequence controls: StartSequence plays a sequence on its own,
    ToggleSequencePause pauses it, SingleStepSequence moves a paused one on
    a frame, and StopSequence ends it."""
    frames = unique_frames(400, 30)
    write_fseq(os.path.join(fppd.media, "sequences", "Solo.fseq"), frames, step_ms=50)
    fppd.start()

    def seq():
        s = status(fppd)
        return s.get("current_sequence", ""), s.get("milliseconds_elapsed", s.get("seconds_played"))

    send("StartSequence,Solo.fseq,0")
    fppd.wait_for(lambda: seq()[0] == "Solo.fseq", timeout=10, what="the sequence to start")
    send("ToggleSequencePause")
    time.sleep(0.5)
    a = seq()[1]
    time.sleep(1)
    b = seq()[1]
    assert a == b, f"a paused sequence moved on: {a} -> {b}"
    send("SingleStepSequence")
    send("StopSequence")
    fppd.wait_for(lambda: seq()[0] == "", timeout=10, what="the sequence to stop")


def test_stop_now_ends_a_lone_sequence(fppd):
    """"d" (Stop Now) stops a sequence started without a playlist, and says
    "Not playing" when nothing is."""
    write_fseq(os.path.join(fppd.media, "sequences", "Solo.fseq"), unique_frames(400, 30))
    fppd.start()
    assert fields(send("d"))[2] == "Not playing"
    send("StartSequence,Solo.fseq,0")
    fppd.wait_for(lambda: status(fppd).get("current_sequence") == "Solo.fseq", timeout=10,
                  what="the sequence to start")
    assert fields(send("d"))[2] == "Sequence Stopping Now"
    fppd.wait_for(lambda: status(fppd).get("current_sequence") == "", timeout=10,
                  what="the sequence to stop")


@pytest.mark.parametrize("cmd", [
    b"", b",", b",,,,", b"\xff\xfe\x00garbage", b"x" * 4095, b"NoSuchCommand,1,2",
    b"LogLevel", b"LogLevel,,", b"LogLevel,nonsense,more", b"v,", b"v,-5", b"v,99999",
    b"SetSetting", b"SetSetting,", b"SetSetting," + b"k" * 300 + b",v",
    b"StartSequence", b"StartSequence,missing.fseq,0", b"StartSequence,../../etc/passwd,0",
    b"StopSequence", b"ToggleSequencePause", b"SingleStepSequence",
    b"SetTestMode", b"SetTestMode,", b"SetTestMode,{not json", b"SetTestMode,[]",
    b"SetupExtGPIO", b"SetupExtGPIO,99999,Output", b"SetupExtGPIO,nosuchpin,PWM",
    b"ExtGPIO,nosuchpin,Input,0", b"ExtGPIO,99999,Output,1", b"ExtGPIO,1",
    b"GetTestMode,extra,args",
], ids=lambda c: repr(c[:40]))
def test_hostile_command_is_survived(fppd, cmd):
    """Whatever arrives on the socket, fppd answers it (possibly with an
    empty datagram) and keeps running."""
    fppd.start()
    # An empty datagram has nothing to answer, and gets nothing.
    send(cmd, reply=bool(cmd))
    assert fields(send("v,50,"))[2] == "Setting Volume", "fppd stopped answering the socket"
    fppd.check_alive()


def test_fpp_cli_reloads_the_schedule(fppd):
    """`fpp -R` makes fppd reread schedule.json."""
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0,
                                       "leadIn": [], "leadOut": [], "mainPlaylist": []})
    fppd.start()
    assert fppd.get("/fppd/schedule")["schedule"]["items"] == []
    year = time.localtime().tm_year
    fppd.write("config/schedule.json", [{"enabled": 1, "day": 7, "playlist": "Show",
                                         "startTime": "23:58:00", "endTime": "23:59:00",
                                         "startDate": f"{year}-01-01", "endDate": f"{year + 1}-12-31",
                                         "repeat": 0, "stopType": 0}])
    rc, out = fpp(fppd, "-R")
    assert rc == 0 and "Reloading Schedule" in out, out
    fppd.wait_for(lambda: fppd.get("/fppd/schedule")["schedule"]["items"], timeout=10,
                  what="the reloaded schedule")


def test_fpp_cli_log_level(fppd):
    """`fpp --log-level LEVEL` sets every logger, `fpp --log-level LOGGER
    LEVEL` one of them, and a level fppd doesn't know is refused.

    Regression: d34e2210b. The CLI sent LogLevel,LEVEL, but the socket command is
    LogLevel,LOGGER,LEVEL, so `fpp --log-level debug`, as its own comment
    documents it, was refused every time.
    """
    def levels():
        return fppd.get("/fppd/log")["log"]

    fppd.start()
    rc, out = fpp(fppd, "--log-level", "debug")
    assert rc == 0 and "Log Level Updated" in out, out
    assert set(levels().values()) == {"debug"}, levels()
    rc, out = fpp(fppd, "--log-level", "MediaOut", "warn")
    assert "Log Level Updated" in out, out
    assert levels()["MediaOut"] == "warn" and levels()["General"] == "debug", levels()
    rc, out = fpp(fppd, "--log-level", "not-a-level")
    assert "Error Updating Log Level" in out and "(null)" not in out, out


def test_fpp_cli_quit_stops_fppd_cleanly(fppd):
    """`fpp -q` (scripts/fppd_stop) shuts fppd down, and fppd exits 0."""
    fppd.start()
    rc, out = fpp(fppd, "-q")
    assert "Shutting Down" in out, out
    rc = fppd.proc.wait(timeout=30)
    assert rc == 0, f"fppd exited {rc} after fpp -q"
    fppd.exit_expected = True


def test_fpp_cli_without_fppd_gives_up(fppd):
    """With no fppd listening, `fpp` reports false within a few seconds
    rather than hanging a script that called it."""
    t0 = time.monotonic()
    rc, out = fpp(fppd, "-R", timeout=20)
    assert out.strip().endswith("false"), out
    assert time.monotonic() - t0 < 10
