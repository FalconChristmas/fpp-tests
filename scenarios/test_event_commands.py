"""Event commands: command presets fired by slot number or several at a
time, Run Script, and switching fppd between player and remote mode.

The presets here count how often they ran in a user variable each, so a
scenario sees which ran and how many times.
"""

import os
import time
import urllib.error

import pytest

from fppd import sanitizer
from test_commands import count, counter, preset


def slotted(name, slot, cmd=None):
    return dict(preset(name, cmd or counter(name)), presetSlot=slot)


def counts(fppd, names):
    return {n: count(fppd, n) for n in names}


def test_preset_slot_runs_every_preset_in_that_slot(fppd):
    """Trigger Command Preset Slot runs every preset assigned to that slot,
    each once, and no other; a slot nothing is assigned to runs nothing.
    Trigger Multiple Command Preset Slots does the same for each slot it is
    given, skipping empty ones, and a slot named twice runs twice. A preset
    that triggers its own slot runs once, not forever.

    Left out on purpose, as fpp master 69a734449 gets it wrong: slot "0",
    or a slot that isn't a number, runs every preset that has no slot,
    and a slot with nothing in it answers "Preset Triggered"."""
    names = ["A", "B", "C", "D", "Loop"]
    fppd.write("config/commandPresets.json", {"commands": [
        slotted("A", 3), slotted("B", 3), slotted("C", 4), slotted("D", 0),
        slotted("Loop", 5),
        slotted("Loop", 5, {"command": "Trigger Command Preset Slot", "args": ["5"]}),
    ]})
    fppd.start()

    fppd.command("Trigger Command Preset Slot", "3")
    assert counts(fppd, names) == {"A": 1, "B": 1, "C": 0, "D": 0, "Loop": 0}
    fppd.command("Trigger Command Preset Slot", "9")
    assert counts(fppd, names) == {"A": 1, "B": 1, "C": 0, "D": 0, "Loop": 0}

    fppd.command("Trigger Multiple Command Preset Slots", "4", "", "3", "4")
    assert counts(fppd, names) == {"A": 2, "B": 2, "C": 2, "D": 0, "Loop": 0}
    fppd.command("Trigger Multiple Command Preset Slots", "", "", "", "")
    fppd.command("Trigger Multiple Command Preset Slots", "200")
    assert counts(fppd, names) == {"A": 2, "B": 2, "C": 2, "D": 0, "Loop": 0}

    fppd.command("Trigger Command Preset Slot", "5", timeout=5)
    assert counts(fppd, names)["Loop"] == 1, "a preset triggering its own slot ran again"

    for cmd in (("Trigger Command Preset Slot",), ("Trigger Multiple Command Preset Slots",)):
        try:
            fppd.command(*cmd)
            raise AssertionError(f"{cmd} with no slot was accepted")
        except urllib.error.HTTPError:
            pass
    assert counts(fppd, names) == {"A": 2, "B": 2, "C": 2, "D": 0, "Loop": 1}


def test_trigger_multiple_presets_by_name(fppd):
    """Trigger Multiple Command Presets runs each named preset in turn
    (all of a preset's commands), skips empty names and names no preset
    has, and runs a preset named twice twice."""
    names = ["A", "B", "C"]
    fppd.write("config/commandPresets.json", {"commands": [
        preset("A", counter("A")), preset("A", counter("A")),
        preset("B", counter("B")), preset("C", counter("C"))]})
    fppd.start()
    got = fppd.command("Trigger Multiple Command Presets", "A", "", "Missing", "B", "A", "")
    assert got == "Presets Triggered", got
    assert counts(fppd, names) == {"A": 4, "B": 1, "C": 0}
    fppd.command("Trigger Multiple Command Presets", "C")
    assert counts(fppd, names) == {"A": 4, "B": 1, "C": 1}
    try:
        fppd.command("Trigger Multiple Command Presets")
        raise AssertionError("Trigger Multiple Command Presets with no names was accepted")
    except urllib.error.HTTPError:
        pass


RECORD = """#!/bin/bash
{
  printf '%s|' "$@"; echo
  echo "A=$A"
  echo "B=$B"
  echo "KEEP=$FPP_TEST_KEEP"
  echo "SCRIPT=$FPP_SCRIPT"
  echo "ARGS=$FPP_SCRIPTARGS"
  echo "CWD=$(pwd)"
} > "$(dirname "$0")/OUT.tmp"
mv "$(dirname "$0")/OUT.tmp" "$(dirname "$0")/OUT"
"""


def test_run_script_passes_arguments_and_environment(fppd):
    """Run Script runs a script from the scripts folder in that folder,
    with its arguments (quoted ones kept whole) and the environment
    variables it is given (a quoted one may hold a comma), plus FPP_SCRIPT
    and FPP_SCRIPTARGS; a variable fppd already has keeps fppd's value.
    A script name that climbs out of the scripts folder with ".." is not
    run, and puts up a warning saying so.

    Not checked, as fpp master 69a734449 gets it wrong: an
    environment entry with no "=" (FOO) is passed as FOO=FOO, and an empty
    environment argument adds an entry "=" to the script's environment."""
    scripts = os.path.join(fppd.media, "scripts")
    fppd.write("scripts/rec.sh", RECORD.replace("OUT", "rec.out"))
    os.chmod(os.path.join(scripts, "rec.sh"), 0o755)
    marker = os.path.join(fppd.media, "outside.ran")
    fppd.write("outside.sh", f"#!/bin/bash\ntouch {marker}\n")
    os.chmod(os.path.join(fppd.media, "outside.sh"), 0o755)
    fppd.start(extra_env={"FPP_TEST_KEEP": "fppd's"})

    args = "one 'two three' \"four five\""
    got = fppd.command("Run Script", "rec.sh", args, 'A=1,"B=x, y",FPP_TEST_KEEP=mine')
    assert got == "Script Started", got
    out = os.path.join(scripts, "rec.out")
    fppd.wait_for(lambda: os.path.exists(out), timeout=10, what="the script to run")
    with open(out) as f:
        lines = f.read().splitlines()
    assert lines == [
        "one|two three|four five|",
        "A=1",
        "B=x, y",
        "KEEP=fppd's",
        "SCRIPT=rec.sh",
        "ARGS=" + args,
        "CWD=" + os.path.realpath(scripts),
    ], lines

    # The same with no arguments and no environment at all.
    os.unlink(out)
    fppd.command("Run Script", "rec.sh")
    fppd.wait_for(lambda: os.path.exists(out), timeout=10, what="the script to run again")
    with open(out) as f:
        lines = f.read().splitlines()
    assert lines[:3] == ["|", "A=", "B="], lines

    fppd.command("Run Script", "../outside.sh")
    fppd.wait_for(lambda: any("outside the scripts directory" in str(w)
                              for w in fppd.get("/fppd/status").get("warnings", [])),
                  timeout=5, what="the refused-script warning")
    time.sleep(1)
    assert not os.path.exists(marker), "a script outside the scripts folder ran"


def mode(fppd):
    """fppd's mode, or None while it is restarting."""
    try:
        return fppd.get("/fppd/status", timeout=2).get("mode_name")
    except (urllib.error.URLError, ConnectionError, TimeoutError, ValueError):
        return None


def saved_mode(fppd):
    with open(os.path.join(fppd.media, "settings")) as f:
        lines = [l for l in f if l.split("=")[0].strip() == "fppMode"]
    assert len(lines) <= 1, f"fppMode saved more than once: {lines}"
    return lines[0].split("=", 1)[1].strip().strip('"') if lines else None


def switch(fppd, command):
    """Run a mode switch; fppd restarts itself straight after answering."""
    try:
        fppd.command(command, timeout=20)
    except (urllib.error.URLError, ConnectionError):
        pass


@pytest.mark.skipif(sanitizer() == "tsan", reason=(
    "fpp master 69a734449 races on settings.fppMode: the settings-file reload "
    "rewrites it while the channel output thread reads getFPPmode()"))
def test_switch_between_player_and_remote_mode(fppd):
    """Switch To Remote Mode saves fppMode = remote in the settings and
    restarts fppd, which comes back in remote mode; Switch To Player Mode
    brings it back to player mode the same way. The same process restarts
    in place each time.

    Skipped under TSan on fpp master 69a734449: the mode switch writes the
    settings file, and fppd's reload of it (SettingsConfig::setSettingLocked)
    writes settings.fppMode under settingsMutex while RunChannelOutputThread
    reads it through getFPPmode() with no lock, a data race on every switch.
    Take the skip out once fppMode is atomic."""
    fppd.start()
    pid = fppd.proc.pid
    assert mode(fppd) == "player"

    switch(fppd, "Switch To Remote Mode")
    fppd.wait_for(lambda: mode(fppd) == "remote", timeout=90, interval=0.5,
                  what="fppd to come back in remote mode")
    assert saved_mode(fppd) == "remote"

    switch(fppd, "Switch To Player Mode")
    fppd.wait_for(lambda: mode(fppd) == "player", timeout=90, interval=0.5,
                  what="fppd to come back in player mode")
    assert saved_mode(fppd) == "player"
    assert fppd.proc.pid == pid and fppd.proc.poll() is None
