"""A playlist started by hand over a scheduled one keeps playing.

Starting a playlist while another plays stops the running one and loads the
new one, and in between the player is briefly idle. The main loop and the
scheduler, which look at the player from another thread, must not take that
moment for a real stop: the scheduler then started a scheduled playlist in the
gap, or pre-empted the playlist that had just been started.
"""

import json
import os
import threading
import time

from ddp import DdpReceiver
from fseq import solid_frames, write_fseq
from show import CHANNELS, install, playlist, sequence_entry, status
from test_mqtt_control import HOST, PORT, _publish_many, broker, publish
from test_plugin_scripts import CALLBACKS, free_http_connection, plugin
from test_scheduler import reload_schedule, schedule_entry, window

SHOW, LOW, OTHER = 50, 70, 90


def current(fppd):
    s = status(fppd)
    return s.get("status_name"), (s.get("current_playlist") or {}).get("playlist")


def command_entry(command, *args):
    return {"type": "command", "enabled": 1, "playOnce": 0, "command": command,
            "args": [str(a) for a in args]}


def add_show(fppd, name, value, frames=40):
    write_fseq(os.path.join(fppd.media, "sequences", f"{name}.fseq"),
               solid_frames(frames, CHANNELS, value), step_ms=50)
    fppd.write(f"playlists/{name}.json", playlist(name, [sequence_entry(f"{name}.fseq")], repeat=1))


def connect_mqtt(fppd):
    """Wait until fppd has subscribed, without publishing anything it acts on."""
    probe = f"falcon/player/{HOST}/set/probe"
    fppd.wait_for(lambda: (_publish_many([probe]) or probe in fppd.get("/fppd/mqtt/cache")),
                  timeout=30, interval=1, what="fppd to connect to the broker")


def watch(fppd, seconds):
    """(status, playlist) every 0.1 s for `seconds`."""
    seen = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        seen.append(current(fppd))
        time.sleep(0.1)
    return seen


def test_mqtt_start_over_a_scheduled_playlist_keeps_playing(fppd):
    """A playlist started over MQTT while the schedule's playlist plays is
    still the one playing seconds later. Three times over.

    Regression (issue #3140): the MQTT start stops the running playlist and
    loads the new one under the playlist lock, idle for 100 ms in between.
    The main loop saw that idle as a stop, asked the scheduler, and the
    scheduler re-armed the repeating entry and stopped the "manual" playlist
    that had just started for it -- since bdc71586c almost every time.
    Fixed by 1120201c6.
    """
    install(fppd, solid_frames(40, CHANNELS, SHOW))
    add_show(fppd, "Other", OTHER)
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                      what="the scheduled playlist to start")
        connect_mqtt(fppd)
        for i in range(3):
            # Let the main loop see Show playing before the switch.
            time.sleep(1.5)
            publish("set/playlist/Other/start")
            seen = watch(fppd, 4)
            assert ("playing", "Other") in seen, \
                f"round {i + 1}: the MQTT-started playlist never played: {sorted(set(seen))}"
            after = seen[seen.index(("playing", "Other")):]
            assert set(after) == {("playing", "Other")}, \
                f"round {i + 1}: the scheduler took over from the MQTT-started playlist: {sorted(set(after))}"
            fppd.command("Stop Now")
            fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=10, interval=0.2,
                          what=f"the scheduled playlist to play again (round {i + 1})")


def test_issue_3140_button_inserts_a_random_item_at_once(fppd):
    """The reporter's show: a repeating scheduled sequence, and a "Button"
    playlist started over MQTT whose one entry is Insert Random Item From
    Playlist with Immediate set. The random item plays at once, and the
    scheduled show does not come back until it has finished.

    Regression (issue #3140): the scheduler stopped Button for the scheduled
    playlist as it started. In 10.3 the pending insert then rode along on the
    restarted show and played after its first pass; on master, where
    416e319ec drops it, the item never played at all. Fixed by 1120201c6.
    """
    install(fppd, solid_frames(40, CHANNELS, SHOW))
    write_fseq(os.path.join(fppd.media, "sequences", "Pool.fseq"),
               solid_frames(100, CHANNELS, OTHER), step_ms=50)  # 5 s
    fppd.write("playlists/Pool.json", playlist("Pool", [sequence_entry("Pool.fseq")]))
    fppd.write("playlists/Button.json", playlist("Button", [
        command_entry("Insert Random Item From Playlist", "Pool", "true")]))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                      what="the scheduled playlist to start")
        connect_mqtt(fppd)
        time.sleep(1.5)
        publish("set/playlist/Button/start")
        fppd.wait_for(lambda: status(fppd).get("current_sequence") == "Pool.fseq", timeout=3,
                      interval=0.1, what="the random item to play at once")
        # Most of its 5 s: nothing takes over while it plays.
        seqs = set()
        for _ in range(30):
            seqs.add(status(fppd).get("current_sequence"))
            time.sleep(0.1)
        assert seqs == {"Pool.fseq"}, f"the inserted item was cut off: {sorted(seqs)}"
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=15, interval=0.5,
                      what="the scheduled playlist to return once the insert is done")


def test_start_playlist_over_a_schedule_never_plays_another_entry_in_the_gap(fppd):
    """Two schedule entries are open; the first (higher priority) plays and
    the second waits behind it. A Start Playlist of a schedule-protected
    playlist goes straight from the first to the new one: the waiting entry
    never plays, not even for a frame. Three times over.

    Regression: Start Playlist (and Toggle Playlist, Start Playlist At Random
    Item) stopped the running playlist, slept 150 ms, then started the new one.
    The scheduler was asked in that real idle gap and started the waiting
    entry, which the start then stopped again: a flash of the wrong show, and
    its window's start used up. Fixed by 1120201c6.
    """
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, solid_frames(40, CHANNELS, SHOW))
        add_show(fppd, "Low", LOW)
        add_show(fppd, "Other", OTHER)
        start, end = window(-60, 600)
        fppd.write("config/schedule.json", [schedule_entry("Show", start, end),
                                            schedule_entry("Low", start, end)])
        fppd.start()
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                      what="the scheduled playlist to start")
        for i in range(3):
            time.sleep(1.5)
            # name, repeat, if not running, schedule protected
            fppd.command("Start Playlist", "Other", "true", "false", "true")
            fppd.wait_for(lambda: current(fppd) == ("playing", "Other"), timeout=10, interval=0.1,
                          what=f"the started playlist to play (round {i + 1})")
            time.sleep(1)
            assert current(fppd) == ("playing", "Other"), f"round {i + 1}: {current(fppd)}"
            fppd.command("Stop Now")
            fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=10, interval=0.2,
                          what=f"the scheduled playlist to play again (round {i + 1})")
        values = {d[0] for _, d in rx.snapshot() if any(d[:CHANNELS])}
    assert LOW not in values, "the waiting schedule entry played in the gap of a Start Playlist"
    assert {SHOW, OTHER} <= values, f"frames seen: {sorted(values)}"


def test_schedule_returns_when_an_mqtt_started_playlist_ends(fppd):
    """A playlist started over MQTT that runs to its end hands the player
    back to the schedule, as one that is stopped does.

    Guards the other side of the #3140 fix (1120201c6): the main loop now
    leaves an idle it sees during a switch unrecorded, and must still act on
    the idle when the started playlist really ends.
    """
    install(fppd, solid_frames(40, CHANNELS, SHOW))
    write_fseq(os.path.join(fppd.media, "sequences", "Once.fseq"),
               solid_frames(40, CHANNELS, OTHER), step_ms=50)  # 2 s
    fppd.write("playlists/Once.json", playlist("Once", [sequence_entry("Once.fseq")]))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                      what="the scheduled playlist to start")
        connect_mqtt(fppd)
        time.sleep(1.5)
        publish("set/playlist/Once/start")
        fppd.wait_for(lambda: current(fppd) == ("playing", "Once"), timeout=5, interval=0.1,
                      what="the MQTT-started playlist to play")
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=10, interval=0.2,
                      what="the scheduled playlist to return after the started one ended")


def test_an_entry_already_due_waits_for_an_mqtt_started_playlist(fppd):
    """Two schedule entries are open; the first plays and the second waits
    behind it. A playlist started over MQTT replaces the first and keeps
    playing: the waiting entry does not take over from it. Stopped, the
    schedule's first entry plays again.

    Regression: the waiting entry had never run, so the next scheduler pass
    took the MQTT-started playlist (manual priority, below every entry) for one
    to pre-empt, and stopped it within a second -- what the reporter of #3140
    would see before 23:00, with HalloweenCalmTime.fseq and
    TestingBarsRGBVertical.fseq both open. Fixed by 9819f7f8c.
    """
    install(fppd, solid_frames(40, CHANNELS, SHOW))
    add_show(fppd, "Low", LOW)
    add_show(fppd, "Other", OTHER)
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end),
                                        schedule_entry("Low", start, end)])
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                      what="the scheduled playlist to start")
        connect_mqtt(fppd)
        time.sleep(1.5)
        publish("set/playlist/Other/start")
        seen = watch(fppd, 4)
        assert ("playing", "Other") in seen, f"the MQTT-started playlist never played: {sorted(set(seen))}"
        after = seen[seen.index(("playing", "Other")):]
        assert set(after) == {("playing", "Other")}, \
            f"a schedule entry that was already due took over: {sorted(set(after))}"
        fppd.command("Stop Now")
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=10, interval=0.2,
                      what="the first schedule entry to play again")


def _entry_comes_due_over(fppd, start_manual):
    """Boot idle, start a playlist by hand (start_manual), then open a
    schedule window: [(status, playlist)] seen from just before it opens."""
    from test_scheduler import wall_of
    install(fppd, solid_frames(40, CHANNELS, SHOW))
    add_show(fppd, "Other", OTHER)
    start, end = window(25, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.start()
    start_manual()
    fppd.wait_for(lambda: current(fppd) == ("playing", "Other"), timeout=10, interval=0.2,
                  what="the playlist started by hand to play")
    lead = wall_of(start) - time.monotonic()
    assert lead > 2, f"setup took too long: the window opens in {lead:.1f}s"
    time.sleep(lead - 1)
    return watch(fppd, 6)


def test_an_entry_coming_due_still_pre_empts_an_mqtt_started_playlist(fppd):
    """A schedule entry whose window opens while a playlist started over MQTT
    plays takes over from it, as it always has: only an entry already due
    waits (guards the other side of 9819f7f8c)."""
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        def start():
            connect_mqtt(fppd)
            publish("set/playlist/Other/start")
        seen = _entry_comes_due_over(fppd, start)
    assert seen[-1] == ("playing", "Show"), f"the entry coming due didn't take over: {sorted(set(seen))}"


def test_mqtt_start_runs_the_stopped_preset_before_the_new_playlist(fppd):
    """A PLAYLIST_STOPPED preset turns the "relay" off; the playlist started
    over MQTT turns it on in its lead-in. Started over a playing playlist, the
    relay is on: the stop's preset ran first, as it does for Start Playlist.

    Regression: the MQTT start left the running playlist for the start to
    stop, inside the playlist transition. Its PLAYLIST_STOPPED preset and
    plugin "stop" callback were deferred to after the new playlist's Start(),
    so they undid its lead-in. Fixed by 04ee4931e.
    """
    install(fppd, solid_frames(40, CHANNELS, SHOW))
    write_fseq(os.path.join(fppd.media, "sequences", "Lit.fseq"),
               solid_frames(40, CHANNELS, OTHER), step_ms=50)
    fppd.write("playlists/Lit.json", playlist(
        "Lit", [sequence_entry("Lit.fseq")], repeat=1,
        lead_in=[command_entry("Set Variable", "Relay", "Value", "on", "1", "0", "100", "")]))
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "PLAYLIST_STOPPED", "command": "Set Variable",
        "args": ["Relay", "Value", "off", "1", "0", "100", ""], "presetSlot": 0}]})
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    with broker():
        fppd.start()
        connect_mqtt(fppd)
        for i in range(3):
            fppd.command("Start Playlist", "Show", "true", "false")
            fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=10, interval=0.2,
                          what=f"Show to play (round {i + 1})")
            publish("set/playlist/Lit/start")
            fppd.wait_for(lambda: current(fppd) == ("playing", "Lit"), timeout=5, interval=0.1,
                          what=f"the MQTT-started playlist to play (round {i + 1})")
            time.sleep(1)
            relay = fppd.get("/variables", timeout=5).get("Relay", {}).get("value")
            assert relay == "on", \
                f"round {i + 1}: the stopped playlist's preset ran after the new one's lead-in (Relay={relay})"


def test_a_hung_plugin_callback_does_not_hold_the_schedule_back(fppd):
    """A script plugin's "stop" callback hangs for 30 s while Start Playlist
    replaces one playlist with another. A schedule entry that comes due 8 s
    later still starts: the switch holds the scheduler back for at most 5 s.

    Guard for 1120201c6 (issue #3140), which holds the scheduler back while
    a playlist switch is running. The Start Playlist command's switch also
    covers the presets and plugin callbacks of its stop, and a script plugin's
    callback is waited for with no timeout, so without the limit a hung
    callback stopped the schedule until it returned.
    """
    install(fppd, solid_frames(40, CHANNELS, SHOW))
    add_show(fppd, "A", LOW)
    add_show(fppd, "B", OTHER)
    d = plugin(fppd, types="playlist")
    with open(os.path.join(d, "callbacks.sh"), "w") as f:
        f.write(CALLBACKS.replace("LIST_DELAY", ":").replace("LIST", "playlist")
                .replace('echo "$*" >> "$LOG"',
                         'echo "$*" >> "$LOG"; case "$*" in *\\"stop\\"*) '
                         '[ -e "$LOG.hung" ] || { touch "$LOG.hung"; sleep 30; };; esac'))
    fppd.start()
    fppd.command("Start Playlist", "A", "true", "false")
    fppd.wait_for(lambda: current(fppd) == ("playing", "A"), timeout=10, interval=0.2,
                  what="A to play")
    start, end = window(8, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    reload_schedule(fppd)
    t = threading.Thread(target=lambda: fppd.command("Start Playlist", "B", "true", "false", timeout=60))
    t.start()
    try:
        fppd.wait_for(lambda: os.path.exists(os.path.join(d, "events.log.hung")), timeout=5,
                      interval=0.1, what="the plugin's stop callback to hang")
        # The hung command blocks its HTTP thread, and a request that lands
        # on it waits too: poll over a connection on a free one.
        conn = free_http_connection(fppd)

        def playing():
            conn.request("GET", "/fppd/status")
            st = json.loads(conn.getresponse().read())
            return st.get("status_name"), (st.get("current_playlist") or {}).get("playlist")
        fppd.wait_for(lambda: playing() == ("playing", "Show"), timeout=15, interval=0.2,
                      what="the entry that came due to start while the callback hangs")
        conn.close()
    finally:
        t.join(60)
