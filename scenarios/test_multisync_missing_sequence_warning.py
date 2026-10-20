"""The "sequence file does not exist" warning on a remote whose master is
playing a sequence the remote doesn't have: up for as long as the master
keeps syncing to it, down as soon as the master stops."""

import time

from test_multisync_remote_sequences import Master, remote


def missing_warnings(fppd, name):
    return [w for w in fppd.get("/fppd/warnings", timeout=5) if name in str(w) and "does not exist" in str(w)]


def test_the_missing_sequence_warning_stays_up_while_the_master_syncs(fppd):
    """A master syncing a sequence the remote lacks for 75 s: the warning is
    raised, is still up at the end -- past the minute it used to last -- and
    is gone within a few seconds of the master's stop packet.

    Regression: 6cb7a1c19 (#2865). The warning was armed once, with a 60 s
    timeout, on the remote's only open attempt (later sync packets for the
    same name short-circuit), so a minute into a song still playing on the
    master the status page showed nothing wrong, just "Waiting for MultiSync
    commands"; and a stop left it up until that timeout.
    """
    remote(fppd)
    fppd.start()
    m = Master("Missing.fseq")
    try:
        m.send("open")
        time.sleep(0.5)
        m.send("start")
        m.began = time.monotonic()
        seen = False
        while time.monotonic() - m.began < 75:
            time.sleep(0.5)
            m.send("sync", m.frame())
            if not seen and time.monotonic() - m.began > 3:
                seen = bool(missing_warnings(fppd, "Missing.fseq"))
                assert seen, f"no missing-sequence warning: {fppd.get('/fppd/warnings')}"
        assert missing_warnings(fppd, "Missing.fseq"), \
            f"the warning was gone after 75 s of sync packets: {fppd.get('/fppd/warnings')}"
        m.send("stop", m.frame())
        fppd.wait_for(lambda: not missing_warnings(fppd, "Missing.fseq"), timeout=10, interval=0.5,
                      what="the warning to come down after the stop packet")
    finally:
        m.close()
