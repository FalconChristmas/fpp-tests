"""A MultiSync remote and the sync packets that trail a stop.

The master stops a media item (or moves on to the next one) while a SYNC for
it is still in flight, so the packet reaches the remote after it has closed
that media.
"""

import os
import socket
import time

from audio import write_tone_wav
from multisync import PORT, sync_packet
from show import status


def _remote(fppd):
    for name in ("A.wav", "B.wav"):
        write_tone_wav(os.path.join(fppd.media, "music", name), 30)
    fppd.settings(fppMode="remote")
    fppd.start()
    time.sleep(2)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    return sock, lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))


def _play(fppd, send, name, seconds=3.0):
    send("open", "media", 0, 0.0, name)
    send("start", "media", 0, 0.0, name)
    began = time.monotonic()
    while time.monotonic() - began < seconds:
        send("sync", "media", 0, time.monotonic() - began, name)
        time.sleep(0.5)
    return time.monotonic() - began


def test_a_sync_after_the_stop_does_not_reopen_the_media(fppd, audio):
    """A remote that was told to stop A.wav ignores an A.wav sync that
    arrives right after, still positioned where the master stopped.

    Regression: 863b4ac0d. UpdateMasterMediaPosition() joined any sync for a
    file that wasn't running mid-stream, so the straggler reopened the media
    the remote had just closed, and it played on with nothing to stop it."""
    sock, send = _remote(fppd)
    try:
        pos = _play(fppd, send, "A.wav")
        send("stop", "media", 0, pos, "A.wav")
        send("sync", "media", 0, pos + 0.1, "A.wav")
        time.sleep(1.0)
        s = status(fppd)
        assert not s.get("media_filename"), f"the stale sync reopened the media: {s}"
    finally:
        sock.close()


def test_a_sync_for_the_last_media_does_not_close_the_next(fppd, audio):
    """After the master starts B.wav, an A.wav sync that was in flight leaves
    B.wav playing.

    Regression: 863b4ac0d. The straggler opened A.wav, closing B.wav to make
    room for it.  (B.wav's own sync would rejoin it, so it is checked first.)"""
    sock, send = _remote(fppd)
    try:
        pos = _play(fppd, send, "A.wav")
        send("stop", "media", 0, pos, "A.wav")
        send("open", "media", 0, 0.0, "B.wav")
        send("start", "media", 0, 0.0, "B.wav")
        send("sync", "media", 0, pos + 0.1, "A.wav")
        time.sleep(1.0)
        # before B.wav's own sync: that would rejoin B.wav and hide the swap
        s = status(fppd)
        assert s.get("media_filename") == "B.wav", f"the stale sync displaced B.wav: {s}"
        send("sync", "media", 0, 1.0, "B.wav")
        time.sleep(0.5)
        s = status(fppd)
        assert s.get("media_filename") == "B.wav", f"the stale sync displaced B.wav: {s}"
    finally:
        send("stop", "media", 0, 0.0, "B.wav")
        sock.close()


def test_a_repeat_of_the_media_still_starts(fppd, audio):
    """The guard doesn't eat a real restart: an item on repeat opens again,
    and its first sync (near the start) is accepted at once."""
    sock, send = _remote(fppd)
    try:
        pos = _play(fppd, send, "A.wav")
        send("stop", "media", 0, pos, "A.wav")
        send("sync", "media", 0, 0.2, "A.wav")
        fppd.wait_for(lambda: status(fppd).get("media_filename") == "A.wav",
                      timeout=10, what="the repeat to start")
    finally:
        send("stop", "media", 0, 0.0, "A.wav")
        sock.close()
