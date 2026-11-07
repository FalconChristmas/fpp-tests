"""A playlist loaded into the player while one is playing, through
MultiSync::SyncPlaylistToMS() -- the public call a native plugin uses to
move the player to a playlist and position, which loads the playlist when
it is not the one in the player. The load empties the playing playlist and
leaves it with no section until something starts it; the playlist item
commands sent then are what is checked. The caller is
syncplaylistplugin.cpp, built by plugin_build.py.

Entries append digits to a trace (see test_playlist_entries.py)."""

import os
import time

import pytest

import plugin_build
from audio import write_tone_wav
from capture import UdpCapture
from multisync import PORT, parse_sync
from show import playlist as media_playlist, status
from test_playlist_commands import start, wait_idle, wait_trace
from test_playlist_entries import pause, playlist, step


@pytest.mark.parametrize("command", ["Restart Playlist Item", "Prev Playlist Item"])
def test_item_commands_after_a_sync_loads_another_playlist(fppd, command):
    """A playing playlist, a plugin's SyncPlaylistToMS() to another
    playlist (which loads it in place), then Restart or Prev Playlist Item:
    fppd keeps running and the player plays the loaded playlist.

    Regression: 8f47496ac. The load leaves the playlist playing with no
    current section, and RestartItem() and PrevItem() indexed the section
    unchecked to stop the current entry -- through a null section here, so
    fppd crashed. They now go through the one bounds-checked accessor."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(60)]))
    fppd.write("playlists/Q.json", playlist("Q", main=[step(7), pause(60)]))
    plugin_build.build_and_install(fppd, "syncplaylistplugin.cpp", "fpp-sync")
    fppd.start()
    fppd.wait_for(lambda: "fpp-sync Sync" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")
    start(fppd, "P")
    wait_trace(fppd, "1")
    assert str(fppd.command("fpp-sync Sync", "0", "0", "Q")) == "ok"
    fppd.command(command)
    fppd.check_alive()
    wait_trace(fppd, "7")
    fppd.command("Stop Now")


@pytest.mark.parametrize("command", ["Pause Playlist", "Next Playlist Item"])
def test_pause_and_next_after_a_sync_loads_another_playlist(fppd, command):
    """The same state, then Pause Playlist or Next Playlist Item: fppd
    ignores it, keeps running, and plays a playlist started afterwards.

    Regression: b088f1688 (Pause) and fab1a90f4 (Next). Pause indexed the
    current section unchecked to pause its entry -- a null section here.
    Next went on into the move with no section to move in (it now returns
    when the section is none of lead-in, main or lead-out) and then stopped
    the entry through the null section. Both now go through the
    bounds-checked accessor of 8f47496ac too."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(60)]))
    fppd.write("playlists/Q.json", playlist("Q", main=[step(7), pause(60)]))
    plugin_build.build_and_install(fppd, "syncplaylistplugin.cpp", "fpp-sync")
    fppd.start()
    fppd.wait_for(lambda: "fpp-sync Sync" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")
    start(fppd, "P")
    wait_trace(fppd, "1")
    assert str(fppd.command("fpp-sync Sync", "0", "0", "Q")) == "ok"
    fppd.command(command)
    fppd.check_alive()
    fppd.command("Stop Now")
    wait_idle(fppd)
    start(fppd, "Q")
    wait_trace(fppd, "7", timeout=10)
    fppd.command("Stop Now")
    wait_idle(fppd)


def media_list(name, song):
    return media_playlist(name, [{"type": "media", "enabled": 1, "playOnce": 0, "mediaName": song}])


def media_syncs(packets):
    return [s for s in (parse_sync(t, p) for t, _, _, p in packets) if s and s.file_type == "media"]


def test_a_sync_to_a_media_entry_plays_it_from_that_time_and_tells_the_remotes(fppd, audio):
    """A plugin's SyncPlaylistToMS(5000, entry 0) with sync packets on: nothing
    is playing, so the entry's media starts, and the remotes are told to open,
    start and sync it at 5 s."""
    write_tone_wav(os.path.join(fppd.media, "music", "A.wav"), 30)
    fppd.write("playlists/PA.json", media_list("PA", "A.wav"))
    plugin_build.build_and_install(fppd, "syncplaylistplugin.cpp", "fpp-sync")
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes="127.0.0.2")
    with UdpCapture(PORT, "127.0.0.2") as cap:
        fppd.start()
        fppd.wait_for(lambda: "fpp-sync SyncSend" in {c["name"] for c in fppd.get("/commands")},
                      timeout=15, interval=0.25, what="the plugin to load")
        assert str(fppd.command("fpp-sync SyncSend", "5000", "0", "PA")) == "ok"
        fppd.wait_for(lambda: status(fppd).get("current_song") == "A.wav", timeout=10, interval=0.1,
                      what=f"A.wav to play; have {status(fppd).get('current_song')!r}")
        time.sleep(0.5)
        sent = media_syncs(cap.snapshot())
    fppd.command("Stop Now")
    acts = [(s.action, s.filename) for s in sent]
    assert ("open", "A.wav") in acts and ("start", "A.wav") in acts, acts
    five = [s for s in sent if s.action == "sync" and s.filename == "A.wav" and abs(s.seconds - 5) < 0.01]
    assert five, [(s.action, s.seconds) for s in sent]
