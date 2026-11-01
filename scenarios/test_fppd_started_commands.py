"""The FPPD_STARTED preset runs once fppd's commands are all registered."""

import time

from test_command_preset_triggers import preset


def test_fppd_started_preset_can_run_a_command_registered_late_in_startup(fppd):
    """A FPPD_STARTED preset whose command is one fppd registers while
    bringing up its main loop (Outputs Off, from the output monitor) runs
    that command; no "No command found" is logged for it.

    Regression: bdd444026. FPPD_STARTED (and the other startup events) was
    fired from main() before MainLoop() set up the output monitor, GPIO
    manager and the rest, so a preset using one of their commands found no
    such command and was dropped."""
    fppd.write("config/commandPresets.json", {"commands": [
        preset("FPPD_STARTED", {"command": "Outputs Off", "args": []})]})
    fppd.start()
    # Positive control: the command exists now, so running it by hand works.
    fppd.command("Outputs Off")
    time.sleep(1)
    log = fppd.log()
    assert 'No command found for "Outputs Off"' not in log, \
        "the FPPD_STARTED preset ran before its command was registered"
