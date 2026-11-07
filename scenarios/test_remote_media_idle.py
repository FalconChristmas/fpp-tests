"""A remote left holding synced media when its master goes away: once the clip
has played to its end and no sync has come for RemoteSyncedMediaIdleTimeout
seconds, the remote closes it (issue #2727: a restarted player left its remotes
holding a finished pipeline, the UI saying "playing", for good). Silence alone
doesn't close it: a clip still playing free-runs through a network glitch.

This script is the master."""

import os
import re
import socket
import time

from audio import write_tone_wav
from multisync import PORT, sync_packet
from show import status

CLOSING = "finished and no sync packet received"


def begin(fppd, name, seconds, **settings):
    """fppd as a remote; open and start `name`, sync it twice, then go quiet."""
    write_tone_wav(os.path.join(fppd.media, "music", name), seconds)
    fppd.settings(fppMode="remote", **settings)
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for action, at in (("open", 0), ("start", 0), ("sync", 0.2), ("sync", 0.4)):
        sock.sendto(sync_packet(action, "media", 0, at, name), ("127.0.0.1", PORT))
        time.sleep(0.2)
    sock.close()
    fppd.wait_for(lambda: status(fppd).get("current_song") == name, timeout=10, interval=0.1,
                  what=f"{name} to start")


def test_a_finished_clip_is_closed_once_the_master_has_gone(fppd, audio):
    """A two-second clip, the master gone after half a second: the remote closes
    it after the timeout, and says what happened."""
    begin(fppd, "Clip.wav", 2, RemoteSyncedMediaIdleTimeout="2")
    fppd.wait_for(lambda: CLOSING in fppd.log(), timeout=20, interval=0.2, what="the clip to be closed")
    assert re.search(r"Synced media '\S*Clip\.wav' finished and no sync packet received in 2 seconds", fppd.log())
    fppd.wait_for(lambda: not status(fppd).get("current_song"), timeout=5, interval=0.1,
                  what=f"the status to let go of it: {status(fppd).get('current_song')!r}")


def test_a_clip_still_playing_rides_out_the_silence(fppd, audio):
    """With a long clip, silence past the timeout closes nothing."""
    begin(fppd, "Long.wav", 30, RemoteSyncedMediaIdleTimeout="2")
    time.sleep(5)
    assert CLOSING not in fppd.log()
    assert status(fppd).get("current_song") == "Long.wav"


def test_a_timeout_of_zero_turns_the_watchdog_off(fppd, audio):
    """RemoteSyncedMediaIdleTimeout 0: a finished clip is left alone."""
    begin(fppd, "Clip.wav", 1, RemoteSyncedMediaIdleTimeout="0")
    time.sleep(5)
    assert CLOSING not in fppd.log()
