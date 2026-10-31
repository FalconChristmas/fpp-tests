"""The media settings file as a running fppd follows it: an edit made under
fppd is read back without a restart (the file monitor's watch on it), a
change to a setting something listens for is logged with its old and new
values, and the setting reads and writes fppd makes on its own (its
command-line options, the excess-level read log) work at all."""

import os
import time

from show import status


def append_settings(fppd, **kv):
    """Add key = "value" lines to the settings file in one write, as an
    editor or the PHP side saving it does; a later line for a key wins."""
    with open(os.path.join(fppd.media, "settings"), "a") as f:
        f.write("".join(f'{k} = "{v}"\n' for k, v in kv.items()))


def test_settings_file_edited_under_fppd_takes_effect(fppd):
    """TimeFormat changed in the settings file while fppd runs shows in the
    status it reports next, with no restart.

    Regression: 4353905c8. fppd read the settings file once at startup; a
    setting saved afterwards (the settings page, a plugin, a hand edit)
    reached fppd only when it was restarted. The commit put the file under
    the file monitor and reloads it on every write."""
    fppd.settings(TimeFormat="Before %Y")
    fppd.start()
    assert status(fppd)["timeStr"] == time.strftime("Before %Y")
    append_settings(fppd, TimeFormat="After %Y")
    fppd.wait_for(lambda: status(fppd)["timeStr"] == time.strftime("After %Y"), timeout=10,
                  what="the edited TimeFormat to reach fppd's status")


def test_settings_file_replaced_under_fppd_is_still_followed(fppd):
    """A settings file replaced by a rename (sed -i, an editor that saves to
    a temp file, a restore) is read back, and so is every edit after it:
    fppd keeps following the file at that name, not the inode it started on.

    Regression: 3f8a01bc2. The settings watch was on the file alone (modificationsOnly), with no
    watch on its directory: a rename over it dropped the kernel's watch and
    nothing re-armed it, so the running fppd saw no settings change at all
    until it was restarted."""
    fppd.settings(TimeFormat="Before %Y")
    fppd.start()
    assert status(fppd)["timeStr"] == time.strftime("Before %Y")
    path = os.path.join(fppd.media, "settings")
    with open(path) as f:
        text = f.read()
    with open(path + ".new", "w") as f:
        f.write(text + 'TimeFormat = "Renamed %Y"\n')
    os.rename(path + ".new", path)
    fppd.wait_for(lambda: status(fppd)["timeStr"] == time.strftime("Renamed %Y"), timeout=10,
                  what="the renamed-in settings file to reach fppd's status")
    append_settings(fppd, TimeFormat="After %Y")
    fppd.wait_for(lambda: status(fppd)["timeStr"] == time.strftime("After %Y"), timeout=10,
                  what="an edit after the rename to reach fppd's status")


def test_a_listened_setting_change_is_logged_with_both_values(fppd):
    """A settings-file edit that changes a setting a part of fppd listens for
    (blankBetweenSequences, which the sequence player re-reads) is logged at
    info level with the setting and its old and new values; one nothing
    listens for (TimeFormat) is not.

    Regression: d3b4a1cbf. A reload logged only "Settings file changed,
    reloading settings" at info, never which setting changed or to what,
    and the same line for any write, whether it changed anything a listener
    acts on or not."""
    fppd.settings(LogLevel_Settings="info", blankBetweenSequences="0", TimeFormat="Before %Y")
    fppd.start()
    append_settings(fppd, blankBetweenSequences="1", TimeFormat="After %Y")
    fppd.wait_for(lambda: status(fppd)["timeStr"] == time.strftime("After %Y"), timeout=10,
                  what="the settings file to be reloaded")
    log = fppd.log()
    assert "Setting blankBetweenSequences changed from 0 to 1" in log, fppd.tail()
    assert "Setting TimeFormat changed" not in log, fppd.tail()


def test_excess_setting_reads_log_the_setting_name(fppd):
    """With the Settings log at excess, each setting read is logged with the
    name of the setting read.

    Regression: 8c7bfd8f1. getSetting() and getSettingInt() passed the
    std::string itself to "%s": the log line carried the bytes of the string
    object (its data pointer), not the name."""
    fppd.settings(LogLevel_Settings="excess", TimeFormat="T%Y")
    fppd.start()
    assert status(fppd)["timeStr"] == time.strftime("T%Y")
    log = fppd.log()
    assert "getSetting(TimeFormat) returning 'T%Y'" in log, fppd.tail()
    assert "getSettingInt(daemonize) returning 0" in log, fppd.tail()


def test_fppd_starts_with_its_numeric_command_line_options(fppd):
    """fppd started with options that store a number (-f stores daemonize 0,
    -P a resume position) starts and answers.

    Regression: f9488407c. SetSetting(key, int) called itself instead of
    setSetting(): the first numeric option recursed until the stack ran out,
    so fppd -f died before it could start."""
    s = fppd.start(argv=[os.path.join(fppd.tree, "src", "fppd"), "-f", "-P", "0"])
    assert s.get("fppd") == "running", s
