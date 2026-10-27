"""A sequence's state, shared by the threads that drive and read it: opened,
paused, stepped and stopped from the command socket, played by the output
thread, read ahead by the reader thread, and reported by status requests and
the MultiSync sync packets the output thread sends -- all at once; and the
locks a sequence's command presets run under.

The races and lock orders here show only under TSan (run.sh --flavor tsan);
under ASan these scenarios are coverage. Each docstring says what it guards.
"""

import os
import time

import shims
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist, sequence_entry, status
from test_command_socket import send
from test_playlist_b_races import hammer

# Long enough that the name never fits std::string's inline buffer: each
# open and close reallocates it.
NAMES = ("A sequence with a name too long to be stored inline.fseq",
         "B and another whose name is longer again than the first one.fseq")


def test_a_sequence_driven_and_read_from_every_side(fppd):
    """Two sequences started in turn, one from the command socket and the
    other as a playlist's entry, each paused, stepped, resumed and stopped,
    while three threads poll status and the output thread sends a MultiSync
    sync packet per frame; the reader thread is slowed between deciding to
    read a frame and reading it (seq_readgap.so), so stops land there. Both
    sequences play, and fppd answers throughout.

    Regression, each a data race (red only under TSan):
    25e93b96b. m_seqFilename was reassigned by the open and close paths
    while status, MultiSync and the output thread's sync packets read it
    with no lock.
    7cd4d36d7. m_seqStarting, set by the open and start on the command
    thread, was a volatile int read by the reader and output threads and
    status.
    4a9c85412. m_seqMSElapsed/m_seqMSRemaining, advanced by the output
    thread every frame, were plain ints read by the playlist's status; and
    m_shuttingDown, set by the destructor at shutdown, was read by the
    reader thread.
    5d3816830. Pause and step set m_seqPaused/m_seqSingleStep on the
    command thread while the output thread read and cleared them.
    d6a43fba8. A stop set m_doneRead under the frame cache lock only, while
    the reader, holding only the read lock, checked it just before
    reading."""
    for i, name in enumerate(NAMES):
        write_fseq(os.path.join(fppd.media, "sequences", name),
                   unique_frames(400, CHANNELS, first=1000 * i))
    fppd.write("playlists/P.json", playlist("P", [sequence_entry(NAMES[1])]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", MultiSyncEnabled="1",
                  MultiSyncRemotes="127.0.0.2")
    fppd.start(preload=[shims.build("seq_readgap.c", libs=())],
               extra_env={"SEQ_READGAP_MS": "20"})
    seen = set()
    turns = [0]

    def drive():
        in_playlist = turns[0] % 2
        turns[0] += 1
        if in_playlist:
            fppd.command("Start Playlist", "P", "false", "false")
        else:
            send(f"StartSequence,{NAMES[0]},0")
        time.sleep(0.4)
        send("ToggleSequencePause")
        for _ in range(3):
            time.sleep(0.06)
            send("SingleStepSequence")
        send("ToggleSequencePause")
        time.sleep(0.3)
        if in_playlist:
            fppd.command("Stop Now")
            time.sleep(0.2)
        else:
            send("StopSequence")
            time.sleep(0.05)

    def poll(path):
        def run():
            s = fppd.get(path, timeout=10)
            if path == "/fppd/status" and s.get("current_sequence"):
                seen.add(s["current_sequence"])
        return run

    hammer(fppd, 10, drive, poll("/fppd/status"), poll("/fppd/sequence"),
           poll("/player/status"))
    assert turns[0] >= 6, f"only {turns[0]} sequences started"
    assert seen >= set(NAMES), f"status named {seen}"
    fppd.wait_for(lambda: not status(fppd).get("current_sequence"), timeout=10,
                  what="the last sequence to stop")


def test_a_stopped_sequences_preset_starts_a_playlist(fppd):
    """A SEQUENCE_STOPPED preset that starts a playlist: a sequence started
    on its own is stopped, the stop is answered, and the preset starts the
    playlist, which plays its own sequence.

    Regression: 8f5696de4. The preset ran inside the close, which held the
    sequence lock and the file read lock. Starting the playlist opened its
    sequence there, and the open waited for the read lock the same thread
    held: fppd's main loop hung for good, the stop never answered. (The
    commit's case, a playlist thread holding the playlist's lock and
    waiting for the sequence lock while a close's preset waits for the
    playlist's lock, is the same preset run under the same locks.)"""
    write_fseq(os.path.join(fppd.media, "sequences", "Lone.fseq"), unique_frames(400, CHANNELS))
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"),
               unique_frames(400, CHANNELS, first=1000))
    fppd.write("playlists/P.json", playlist("P", [sequence_entry("Show.fseq")]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/commandPresets.json", {"commands": [
        {"name": "SEQUENCE_STOPPED", "command": "Start Playlist", "args": ["P", "false", "false"],
         "presetSlot": 0}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    send("StartSequence,Lone.fseq,0")
    time.sleep(1)
    send("StopSequence")

    def playing():
        s = status(fppd)
        return (s.get("current_playlist") or {}).get("playlist"), s.get("current_sequence")
    fppd.wait_for(lambda: playing() == ("P", "Show.fseq"), timeout=10,
                  what="the preset to start the playlist")
