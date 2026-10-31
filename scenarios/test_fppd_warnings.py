"""Warnings fppd raises for conditions it finds at start."""


def test_the_boot_delay_warning_names_the_wait(fppd):
    """While boot is delayed (tmp/boot_delay, written by fppinit as
    "<start time>,<seconds>" or "<start time>,auto") fppd warns that the
    delay is in progress, naming the seconds or the automatic wait for a
    valid clock; the older one-word form is understood too.

    Feature: 71985ef15 (the warning), with the auto form from 9ef699bb4's
    delay.
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
