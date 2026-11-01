"""Event commands: command presets fired by slot number or several at a
time, Run Script, and switching fppd between player and remote mode.

The presets here count how often they ran in a user variable each, so a
scenario sees which ran and how many times.
"""

import os
import time
import urllib.error

from test_commands import count, counter, preset


def slotted(name, slot, cmd=None):
    return dict(preset(name, cmd or counter(name)), presetSlot=slot)


def counts(fppd, names):
    return {n: count(fppd, n) for n in names}


def refused(fppd, *cmd):
    """The body of the error a command answers; fails if it succeeds."""
    try:
        got = fppd.command(*cmd)
    except urllib.error.HTTPError as e:
        return e.body
    raise AssertionError(f"{cmd} was answered {got!r}")


def test_preset_slot_runs_every_preset_in_that_slot(fppd):
    """Trigger Command Preset Slot runs every preset assigned to that slot,
    each once, and no other; a slot nothing is assigned to runs nothing and
    says so (not an error: button boxes point at empty slots). Slot "0"
    (what a preset with no slot holds), 256, and a slot that isn't a whole
    number are refused and run nothing; spaces round it and "3.0" are slot 3.
    Trigger Multiple Command Preset Slots does the same for each slot it is
    given, skipping empty and invalid ones, and a slot named twice runs
    twice. A preset that triggers its own slot runs once, not forever.

    Regression: 32ebc1f40. Both commands read the slot with atoi(), so "0"
    or "x" ran every preset with no slot, and an empty slot answered "Preset
    Triggered". And 909939f0b: the slot trigger unlocked the presets lock
    once per matching preset, so a second preset in the slot threw
    (std::system_error, "Operation not permitted") and fppd crashed."""
    names = ["A", "B", "C", "D", "Loop"]
    fppd.write("config/commandPresets.json", {"commands": [
        slotted("A", 3), slotted("B", 3), slotted("C", 4), slotted("D", 0),
        slotted("Loop", 5),
        slotted("Loop", 5, {"command": "Trigger Command Preset Slot", "args": ["5"]}),
    ]})
    fppd.start()

    got = fppd.command("Trigger Command Preset Slot", "3")
    assert got == "Preset Triggered", got
    assert counts(fppd, names) == {"A": 1, "B": 1, "C": 0, "D": 0, "Loop": 0}
    got = fppd.command("Trigger Command Preset Slot", "9")
    assert got == "No preset in slot 9", got
    assert counts(fppd, names) == {"A": 1, "B": 1, "C": 0, "D": 0, "Loop": 0}
    for slot in ("0", "x", "", "3x", "3.5", "256"):
        assert "Invalid preset slot" in refused(fppd, "Trigger Command Preset Slot", slot), slot
    assert counts(fppd, names) == {"A": 1, "B": 1, "C": 0, "D": 0, "Loop": 0}
    for slot in (" 3", "3 ", "3.0"):
        got = fppd.command("Trigger Command Preset Slot", slot)
        assert got == "Preset Triggered", (slot, got)
    assert counts(fppd, names) == {"A": 4, "B": 4, "C": 0, "D": 0, "Loop": 0}

    fppd.command("Trigger Multiple Command Preset Slots", "4", "", "3", "4")
    assert counts(fppd, names) == {"A": 5, "B": 5, "C": 2, "D": 0, "Loop": 0}
    fppd.command("Trigger Multiple Command Preset Slots", "", "", "", "")
    fppd.command("Trigger Multiple Command Preset Slots", "200")
    fppd.command("Trigger Multiple Command Preset Slots", "0", "x", "", "")
    assert counts(fppd, names) == {"A": 5, "B": 5, "C": 2, "D": 0, "Loop": 0}

    fppd.command("Trigger Command Preset Slot", "5", timeout=5)
    assert counts(fppd, names)["Loop"] == 1, "a preset triggering its own slot ran again"

    for cmd in (("Trigger Command Preset Slot",), ("Trigger Multiple Command Preset Slots",)):
        try:
            fppd.command(*cmd)
            raise AssertionError(f"{cmd} with no slot was accepted")
        except urllib.error.HTTPError:
            pass
    assert counts(fppd, names) == {"A": 5, "B": 5, "C": 2, "D": 0, "Loop": 1}


def test_trigger_multiple_presets_by_name(fppd):
    """Trigger Multiple Command Presets runs each named preset in turn
    (all of a preset's commands), skips empty names and names no preset
    has, and runs a preset named twice twice.

    Regression: 909939f0b. Two presets sharing a name (A here) unlocked the
    presets lock once each, and the second unlock threw
    (std::system_error, "Operation not permitted"): fppd crashed.

    Also 6e3e91e8f: the command itself, which runs every name given."""
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
  echo "FOO=${FOO-unset}"
} > "$(dirname "$0")/OUT.tmp"
mv "$(dirname "$0")/OUT.tmp" "$(dirname "$0")/OUT"
"""


def test_run_script_passes_arguments_and_environment(fppd):
    """Run Script runs a script from the scripts folder in that folder,
    with its arguments (quoted ones kept whole) and the environment
    variables it is given (a quoted one may hold a comma), plus FPP_SCRIPT
    and FPP_SCRIPTARGS; a variable fppd already has keeps fppd's value.
    An environment entry with no "=" (FOO) is left out.

    Regression: 4bf5304bc. FOO was passed as FOO=FOO. (The same fix drops
    the "=" entry an empty environment argument added, but bash doesn't pass
    a variable with no name on to a script, so that can't be seen from
    here.)"""
    scripts = os.path.join(fppd.media, "scripts")
    fppd.write("scripts/rec.sh", RECORD.replace("OUT", "rec.out"))
    os.chmod(os.path.join(scripts, "rec.sh"), 0o755)
    fppd.start(extra_env={"FPP_TEST_KEEP": "fppd's"})

    args = "one 'two three' \"four five\""
    got = fppd.command("Run Script", "rec.sh", args, 'A=1,"B=x, y",FPP_TEST_KEEP=mine,FOO')
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
        "FOO=unset",
    ], lines

    # The same with no arguments and no environment at all, and with both
    # empty, as the UI sends them.
    for given in ((), ("", "")):
        os.unlink(out)
        fppd.command("Run Script", "rec.sh", *given)
        fppd.wait_for(lambda: os.path.exists(out), timeout=10, what=f"the script to run with {given}")
        with open(out) as f:
            lines = f.read().splitlines()
        assert lines[:3] == ["|", "A=", "B="], (given, lines)


def test_run_script_refuses_a_script_outside_the_scripts_folder(fppd):
    """A Run Script name that climbs out of the scripts folder with ".." is
    not run: the command answers with an error and a warning goes up saying
    so.

    Regression: 7231a0b5a. The refused script was answered "Script
    Started"."""
    marker = os.path.join(fppd.media, "outside.ran")
    fppd.write("outside.sh", f"#!/bin/bash\ntouch {marker}\n")
    os.chmod(os.path.join(fppd.media, "outside.sh"), 0o755)
    fppd.start()

    try:
        got = fppd.command("Run Script", "../outside.sh")
        raise AssertionError(f"a script outside the scripts folder was answered {got!r}")
    except urllib.error.HTTPError as e:
        assert e.code == 500, e.code
        assert e.body == "Script Not Started"
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


def test_switch_between_player_and_remote_mode(fppd):
    """Switch To Remote Mode saves fppMode = remote in the settings and
    restarts fppd, which comes back in remote mode; Switch To Player Mode
    brings it back to player mode the same way. The same process restarts
    in place each time.

    Regression: 1eded48e4 (run with --flavor tsan). The mode switch writes
    the settings file, and fppd's reload of it (SettingsConfig::setSettingLocked)
    wrote settings.fppMode under settingsMutex while RunChannelOutputThread
    read it through getFPPmode() with no lock, a data race on every switch.

    Feature: 9248b19db (the two commands).

    Regression: 609c3ef29. The commands ran /opt/fpp/scripts/common, so
    from a tree anywhere else the mode was never saved and fppd came back
    in player mode."""
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
