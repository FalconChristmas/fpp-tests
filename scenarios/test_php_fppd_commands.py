"""The commands the web UI's PHP sends fppd's command socket, as the PHP
builds them, and what fppd does with them: the fppd end of the web suite's
tests of what the PHP sends (web/tests/command-socket-commands.spec.ts)."""

import time

from test_command_socket import send


def settings_log(fppd, key):
    """fppd's "Setting <key>: from A to B" debug lines, oldest first."""
    return [l for l in fppd.log().splitlines() if f"Setting {key}:  from " in l]


def test_the_pipewire_setting_commands_change_fppd_settings(fppd):
    """The PipeWire endpoints' setting pushes change fppd's running settings:
    SetFppdSetting() in www/api/controllers/pipewire.php sends
    "SetSetting,<key>,<value>" and ApplyPipeWireVideoGroups()'s clear sends
    "SetSetting,<key>," (both quoted from the handler code). The lower-case
    "setSetting" they sent before is refused and changes nothing.

    Receiving end of d668b5d31, whose fix is in the PHP: fppd's handling of
    these commands is unchanged by it, so this passes on its parent too; the
    web spec is the red/green half."""
    fppd.settings(PipeWireVideoSinkName="fpp-tests-video-sink", LogLevel_Settings="debug")
    fppd.start()

    reply = send("setSetting,PipeWireVideoSinkName,")
    assert reply.startswith("Invalid command: 'setSetting'"), reply
    time.sleep(0.5)
    assert settings_log(fppd, "PipeWireVideoSinkName") == [], "the refused command changed the setting"

    send("SetSetting,PipeWireSinkName,fpp-tests-group-sink", reply=True)
    fppd.wait_for(lambda: settings_log(fppd, "PipeWireSinkName"), timeout=5,
                  what="PipeWireSinkName to change")
    assert settings_log(fppd, "PipeWireSinkName")[-1].endswith("from  to fpp-tests-group-sink"), \
        settings_log(fppd, "PipeWireSinkName")

    send("SetSetting,PipeWireVideoSinkName,", reply=True)
    fppd.wait_for(lambda: settings_log(fppd, "PipeWireVideoSinkName"), timeout=5,
                  what="PipeWireVideoSinkName to be cleared")
    assert settings_log(fppd, "PipeWireVideoSinkName")[-1].endswith("from fpp-tests-video-sink to "), \
        settings_log(fppd, "PipeWireVideoSinkName")
