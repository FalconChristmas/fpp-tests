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
    (the UI clears settings that way: "SetSetting,name,,").

    Regression: d14d35171. The value was read with strtok_r, which skips
    empty fields, so "SetSetting,name,," never called SetSetting() and the
    old value stayed."""
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
    empty datagram) and keeps running.

    Regression: 79f087671 (its empty-command half). "," and ",,,," left
    strtok_r with no token, and the NULL went to strncpy: SIGSEGV.
    Regression: df831028c. "LogLevel" and "LogLevel,," handed
    FPPLogger::SetLevel a NULL name or level, which strcmp dereferenced."""
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


def test_log_level_changes_while_the_output_thread_logs(fppd):
    """`fpp --log-level ChannelOut ...` again and again while a sequence
    plays, and the channel output thread checks that logger's level on each
    of its log calls. Only a TSan build can tell: it reports the race.

    Regression: 4922bd311. A logger's level was a plain member, written on
    the main loop and read on every thread that logs."""
    write_fseq(os.path.join(fppd.media, "sequences", "Solo.fseq"), unique_frames(400, 30))
    fppd.start()
    send("StartSequence,Solo.fseq,0")
    fppd.wait_for(lambda: status(fppd).get("current_sequence") == "Solo.fseq", timeout=10,
                  what="the sequence to start")
    for level in ("excess", "info") * 5:
        rc, out = fpp(fppd, "--log-level", "ChannelOut", level)
        assert "Log Level Updated" in out, out
        time.sleep(0.5)
    send("StopSequence")


def test_fpp_cli_prints_a_reply_longer_than_256_bytes(fppd):
    """A reply longer than 256 bytes (fppd's go up to 1500) comes back from
    `fpp` whole: here the refusal of a 300-character logger name.

    Regression: e2ba86d09. The CLI read at most 256 bytes into a 256-byte
    buffer and wrote its terminating NUL one past the end: a long reply was
    cut short, and in a sanitizer build the CLI died on the overflow."""
    fppd.start()
    name = "L" * 300
    r = subprocess.run([os.path.join(fppd.tree, "src", "fpp"), "--log-level", name, "debug"],
                       capture_output=True, text=True, timeout=15,
                       env=dict(os.environ, LD_LIBRARY_PATH=os.path.join(fppd.tree, "src")))
    assert r.returncode == 0, f"fpp exited {r.returncode}:\n{r.stderr[-3000:]}"
    assert "Error Updating Log Level," + name + ",debug" in r.stdout, r.stdout


def test_fpp_cli_quit_stops_fppd_cleanly(fppd):
    """`fpp -q` (scripts/fppd_stop) shuts fppd down at once, and fppd exits 0.

    Regression: 401b593f0. "q" was answered with an empty datagram, which
    `fpp` doesn't take as a reply: it sat out its ~2 s timeout on every stop
    and printed "false"."""
    fppd.start()
    t0 = time.monotonic()
    rc, out = fpp(fppd, "-q")
    took = time.monotonic() - t0
    assert "Shutting Down" in out, out
    assert took < 1.5, f"fpp -q took {took:.1f} s to return"
    rc = fppd.proc.wait(timeout=30)
    assert rc == 0, f"fppd exited {rc} after fpp -q"
    fppd.exit_expected = True


def test_fpp_cli_restart_restarts_fppd(fppd):
    """`fpp -r`, what systemd's reload and the reset page run, restarts
    fppd in place: it comes back, answering, with its uptime started over.

    Regression: b0f7c49bf. Taking out the options the API covers (8f48e8fc4)
    took -r with them, so `fpp -r` printed the usage and fppd carried on."""
    fppd.start()
    fppd.wait_for(lambda: status(fppd).get("uptimeTotalSeconds", 0) >= 4, timeout=15,
                  what="fppd to be up 4 s")
    rc, out = fpp(fppd, "-r")
    assert "Usage" not in out, f"fpp -r is not a command:\n{out[-1500:]}"

    def restarted():
        try:
            return status(fppd).get("uptimeTotalSeconds", 99) < 3
        except Exception:  # noqa: BLE001 -- not answering while it restarts
            return False
    fppd.wait_for(restarted, timeout=30, interval=0.3, what="fppd to restart with its uptime reset")


def test_fpp_cli_without_fppd_gives_up(fppd):
    """With no fppd listening, `fpp` reports false within a few seconds
    rather than hanging a script that called it."""
    t0 = time.monotonic()
    rc, out = fpp(fppd, "-R", timeout=20)
    assert out.strip().endswith("false"), out
    assert time.monotonic() - t0 < 10


def test_replies_reach_each_sender_of_one_batch(fppd):
    """Two clients whose datagrams fppd reads in one go -- a short socket
    path, then a long one -- each get their own reply.

    Regression: d5587f547. recvfrom() shrinks the address length to the
    sender's, and it was set only once for the loop, so the second datagram's
    reply address was cut to the first sender's length: the reply went to a
    path that doesn't exist and the long-path client (PHP's SendCommand,
    say) waited out its timeout."""
    import signal
    paths = ["/run/fppd/s", "/run/fppd/" + "l" * 80]
    fppd.start()
    socks = []
    for p in paths:
        if os.path.exists(p):
            os.unlink(p)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        s.bind(p)
        s.settimeout(5)
        socks.append(s)
    try:
        for rnd in range(5):
            # Stopped, so both datagrams are waiting when fppd next reads.
            os.kill(fppd.proc.pid, signal.SIGSTOP)
            try:
                for i, s in enumerate(socks):
                    s.sendto(f"v,{50 + i},".encode(), SERVER)
            finally:
                os.kill(fppd.proc.pid, signal.SIGCONT)
            for p, s in zip(paths, socks):
                try:
                    reply = s.recv(4096).decode(errors="replace")
                except socket.timeout:
                    pytest.fail(f"round {rnd}: no reply to the client at {p[:20]}... ({len(p)} bytes)")
                assert "Setting Volume" in reply, reply
    finally:
        for p, s in zip(paths, socks):
            s.close()
            os.unlink(p)


# A script plugin whose shutdown callback takes a second, as one stopping a
# daemon of its own does: part of fppd's orderly exit.
SLOW_SHUTDOWN_PLUGIN = """#!/bin/bash
case "$1" in
    --list) echo lifecycle ;;
    --type)
        if [ "$3" = shutdown ]; then
            sleep 1
            echo shutdown-done >> "$(dirname "$0")/events.log"
        fi ;;
esac
"""


@pytest.mark.skipif(not os.path.exists("/etc/fpp/container"),
                    reason="fppd_stop kills every fppd by name: the device's own under run-local.sh")
def test_fppd_stop_waits_for_a_playing_fppd_to_finish(fppd):
    """scripts/fppd_stop, with a playlist playing, gives fppd the time its
    orderly shutdown takes (stopping the playlist, then its teardown: here a
    plugin's one-second shutdown callback) instead of killing it partway,
    and fppd exits 0.

    Regression: 30c7ef54a. fppd_stop sent SIGBUS about a second after
    `fpp -q` gave up waiting, while stopping the playlist alone held fppd's
    main loop for ~3 s: that left ~250 ms for the teardown, so on a device
    the kill landed before the outputs were closed and pixel strings kept
    showing whatever they last had through the reboot.
    """
    import show
    from test_crash_reports import private_fppdir
    show.install(fppd, unique_frames(1200, 30))
    fppd.write("plugins/fpp-tests-slow-stop/callbacks.sh", SLOW_SHUTDOWN_PLUGIN)
    os.chmod(os.path.join(fppd.media, "plugins", "fpp-tests-slow-stop", "callbacks.sh"), 0o755)
    fppd.start()
    fppd.command("Start Playlist", "Show", "true", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10, what="playing")
    view = private_fppdir(fppd.tree, fppd.media)
    r = subprocess.run(["bash", os.path.join(view, "scripts", "fppd_stop")], capture_output=True,
                       text=True, timeout=60,
                       env=dict(os.environ, LD_LIBRARY_PATH=os.path.join(fppd.tree, "src")))
    try:
        rc = fppd.proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        raise AssertionError(f"fppd still running after fppd_stop:\n{r.stdout}\n{fppd.tail()}")
    fppd.exit_expected = True
    assert rc == 0, f"fppd exited {rc} under fppd_stop, not on its own:\n{r.stdout}\n{fppd.tail()}"
    with open(os.path.join(fppd.media, "plugins", "fpp-tests-slow-stop", "events.log")) as f:
        assert "shutdown-done" in f.read(), "the plugin's shutdown callback didn't finish"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(x[:8000] for x in reports)


def test_gpio_commands_take_a_pin_by_name(fppd):
    """SetupExtGPIO and ExtGPIO name a pin the way the UI lists it (a cape's
    pin name, here the container's TF-3), not only by GPIO number: the pin is
    set up as an output, driven high and driven low again, seen as the
    pin's file in /tmp, and an unknown name is refused.

    Regression: 413ec4070. The commands took a number from atoi(), so a
    named pin became GPIO 0 and nothing named was ever driven."""
    pin = "/tmp/GPIO-TF-3"
    if os.path.exists(pin):
        os.unlink(pin)
    fppd.start()
    r = fields(send("SetupExtGPIO,TF-3,Output"))
    assert r[1] == "1" and r[3] == "TF-3", r
    fppd.wait_for(lambda: fields(send("ExtGPIO,TF-3,Output,1"))[1] == "1" and os.path.exists(pin), timeout=5,
                  what="the pin to be driven high")
    send("ExtGPIO,TF-3,Output,0")
    fppd.wait_for(lambda: not os.path.exists(pin), timeout=5, what="the pin to be driven low")
    assert fields(send("SetupExtGPIO,NO-SUCH-PIN,Output"))[1] != "1"
