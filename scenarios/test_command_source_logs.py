"""Where a request that changes what fppd does came from, in fppd.log at
debug level: for troubleshooting a box whose lights change on their own."""

import socket
import time
import urllib.parse

from multisync import PORT, fpp_command_packet
from show import playlist
from test_command_socket import send
from test_commands import command_entry, preset, set_variable, variable


def lines_with(fppd, *needles):
    return [l for l in fppd.log().splitlines() if all(n in l for n in needles)]


def run_three_ways(fppd, name):
    """Set Variable <name> by a bare JSON POST /command, a POST
    /command/<name> and a GET /command/<name>/<args>, then wait for the
    last to land."""
    args = ["Value", "abc123", "1", "0", "100", ""]
    fppd.post("/command", {"command": "Set Variable", "args": [name + "1"] + args})
    fppd.post("/command/Set%20Variable", [name + "2"] + args)
    fppd.get("/command/" + "/".join(urllib.parse.quote(p, safe="") for p in
                                    ["Set Variable", name + "3"] + args[:-1]))
    fppd.wait_for(lambda: variable(fppd, name + "3") == "abc123", timeout=5, what="the commands to run")


def test_a_test_mode_post_logs_its_client_and_body(fppd):
    """A POST to /fppd/testing (the Display Testing page, and anything else
    that starts test mode directly) is logged at debug level for Command
    with the client's address and the test it asked for.

    Regression: 07305038c (feat: more logging of where FPP commands come
    from). Its parent logged nothing for this request. The commit's fppoled
    half -- its button actions and the commands it sends, now logged at
    debug instead of printed -- can't be shown: fppoled has no way to raise
    its own log level from info, and it sends to port 80, where nothing
    listens in a test.
    """
    fppd.settings(LogLevel_Command="debug")
    fppd.start()
    body = {"enabled": 1, "mode": "RGBFill", "cycleMS": 1000, "channelSet": "1-30",
            "channelSetType": "channelRange", "color1": "#202020", "color2": 32, "color3": 48}
    fppd.post("/fppd/testing", body)
    fppd.post("/fppd/testing", dict(body, enabled=0))
    # "POST /api/fppd/testing from" since 1bd0edece
    lines = [l for l in fppd.log().splitlines() if "/fppd/testing from " in l]
    assert len(lines) == 2, fppd.log()[-3000:]
    assert "from 127.0.0.1" in lines[0] and '"mode":"RGBFill"' in lines[0].replace(" ", ""), lines


def test_a_command_and_its_arguments_are_logged_at_info(fppd):
    """At info level for Command, every route a command arrives on logs the
    command with its arguments; the payload lines (the MQTT publish, the
    body received) wait for excess, and the bare-JSON route's source line
    for debug.

    Regression: 1bd0edece. "Running command" was a debug line, without the
    arguments on the GET and POST /command/<name> routes."""
    fppd.settings(LogLevel_Command="info")
    fppd.start()
    run_three_ways(fppd, "Info")
    for n in "123":
        assert lines_with(fppd, "unning command", f'"Set Variable(Info{n},Value,abc123'), \
            f"no info line for Info{n}:\n" + fppd.log()[-3000:]
    assert not lines_with(fppd, "MQTT Publishing command"), "an excess line at info"
    assert not lines_with(fppd, "Received command:"), "an excess line at info"
    assert not lines_with(fppd, "(bare JSON body) from"), "a debug line at info"


def test_routine_command_runs_log_no_warning(fppd):
    """At the default log level a command run by each HTTP route leaves no
    "MQTT Publishing command" line: announcing it on MQTT is routine.

    Regression: 43b5959c8. The three routes logged that line at warning, so
    every command run put a warning in fppd.log."""
    fppd.start()
    run_three_ways(fppd, "Quiet")
    time.sleep(0.5)
    assert not lines_with(fppd, "MQTT Publishing command"), "\n".join(lines_with(fppd, "MQTT Publishing"))


def test_each_way_a_command_arrives_is_logged_with_its_source(fppd):
    """At debug level for Command, a command run by a playlist entry, a
    command preset, a MultiSync FPP Command packet from another host and the
    local command socket each logs a line naming where it came from.

    Regression: ea27b2b0a, which added those lines. Its parent logged only
    "Running command", the same for every source."""
    fppd.settings(LogLevel_Command="debug")
    fppd.write("config/commandPresets.json", {"commands": [preset("Logged", set_variable("ByPreset", "1"))]})
    fppd.write("playlists/Logged.json", playlist("Logged", [command_entry(set_variable("ByEntry", "1"))]))
    fppd.start()

    fppd.command("Start Playlist", "Logged", "false", "false")
    fppd.wait_for(lambda: variable(fppd, "ByEntry") == "1", timeout=10, what="the playlist entry to run")
    fppd.command("Trigger Command Preset", "Logged")
    fppd.wait_for(lambda: variable(fppd, "ByPreset") == "1", timeout=5, what="the preset to run")
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.sendto(fpp_command_packet("Set Variable", ["ByPacket", "Value", "1", "1", "0", "100", ""]),
                 ("127.0.0.1", PORT))
    finally:
        s.close()
    fppd.wait_for(lambda: variable(fppd, "ByPacket") == "1", timeout=5, what="the packet's command to run")
    send("v,40,")

    assert lines_with(fppd, "Playlist entry #", 'running command "Set Variable"'), fppd.log()[-3000:]
    assert lines_with(fppd, 'Command Preset "Logged"', 'running command "Set Variable"'), fppd.log()[-3000:]
    assert lines_with(fppd, '"Set Variable"', "from remote host"), fppd.log()[-3000:]
    fppd.wait_for(lambda: lines_with(fppd, "Local command socket", '"v,40,"'), timeout=5,
                  what="the command socket line")
