"""Warnings fppd raises for conditions it finds at start."""


def test_the_boot_delay_warning_names_the_wait(fppd):
    """While boot is delayed (tmp/boot_delay, written by fppinit as
    "<start time>,<seconds>" or "<start time>,auto") fppd warns that the
    delay is in progress, naming the seconds or the automatic wait for a
    valid clock; the older one-word form is understood too.

    Feature: 71985ef15 (the warning), with the auto form from 9ef699bb4's
    delay.

    Also 35c03fd64: the /fppd/warnings endpoint it reads (a bare list of
    the messages; 404 without it).
    """
    want = {
        "1767225600,30": "Boot delay in progress: Waiting 30 seconds before starting FPPD",
        "1767225600,auto": "Boot delay in progress: Waiting for valid system time (NTP/RTC) - up to 5 minutes",
        "45": "Boot delay in progress: Waiting 45 seconds before starting FPPD",
        "auto": "Boot delay in progress: Waiting for valid system time (NTP/RTC) - up to 5 minutes",
    }
    for i, (content, message) in enumerate(want.items()):
        if i:
            fppd.stop()
            fppd.exit_expected = True
        fppd.write("tmp/boot_delay", content)
        fppd.start()
        fppd.wait_for(lambda: message in fppd.get("/fppd/warnings"), timeout=10,
                      what=f"{message!r} for {content!r}; have {fppd.get('/fppd/warnings')}")


def test_a_plugins_edits_to_fpp_are_named_in_a_warning(fppd):
    """logs/fpp_tree_modified.txt lists the FPP files plugins changed, one
    "<plugin><tab><file>" a line. fppd warns which plugins changed how many
    files, each plugin once and in order, and ignores a line with no plugin."""
    fppd.write("logs/fpp_tree_modified.txt",
               "zeta\twww/a.php\nalpha\twww/b.php\nzeta\tscripts/c\nno tab here\n\tno-plugin\n\n")
    fppd.start()
    want = "Plugin alpha, zeta modified 3 of FPP's own files."
    fppd.wait_for(lambda: any(w.startswith(want) for w in fppd.get("/fppd/warnings")), timeout=10,
                  what=f"{want!r}; have {fppd.get('/fppd/warnings')}")


def test_no_plugin_edit_warning_from_a_file_that_names_none(fppd):
    """A logs/fpp_tree_modified.txt with no "<plugin><tab><file>" line in it
    raises nothing."""
    fppd.write("logs/fpp_tree_modified.txt", "no tab here\n\tno-plugin\n")
    fppd.start()
    assert "Starting main processing loop" in fppd.log()
    assert not [w for w in fppd.get("/fppd/warnings") if "of FPP's own files" in w]
