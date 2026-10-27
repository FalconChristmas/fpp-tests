"""A playlist loaded into the player while one is playing, through
MultiSync::SyncPlaylistToMS() -- the public call a native plugin uses to
move the player to a playlist and position, which loads the playlist when
it is not the one in the player. The load empties the playing playlist and
leaves it with no section until something starts it; the playlist item
commands sent then are what is checked. The caller is
syncplaylistplugin.cpp, built by plugin_build.py.

Entries append digits to a trace (see test_playlist_entries.py)."""

import pytest

import plugin_build
from test_playlist_commands import start, wait_trace
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
