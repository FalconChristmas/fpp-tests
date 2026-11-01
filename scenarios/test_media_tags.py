"""The tags fppd reads from a media file (TagLib) and hands to plugins."""

import json
import os
import struct

from audio import write_tone_wav
from show import playlist
from test_plugin_scripts import plugin

TITLE = "Café Noël – 北京"
ARTIST = "Björk Guðmundsdóttir"


def syncsafe(n):
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])


def text_frame(frame_id, text):
    """An ID3v2.4 text frame, encoded UTF-8 (encoding byte 3)."""
    body = b"\x03" + text.encode()
    return frame_id.encode() + syncsafe(len(body)) + b"\0\0" + body


def tag_wav(path, **frames):
    """Add an ID3v2.4 tag to a WAV file as an "id3 " chunk, which is where
    TagLib looks for one."""
    body = b"".join(text_frame(k, v) for k, v in frames.items())
    tag = b"ID3\x04\0\0" + syncsafe(len(body)) + body
    if len(tag) % 2:
        tag += b"\0"
    with open(path, "r+b") as f:
        data = f.read()
        f.seek(0)
        f.write(data + b"id3 " + struct.pack("<I", len(tag)) + tag)
        f.seek(4)
        f.write(struct.pack("<I", len(data) + 8 + len(tag) - 8))


def test_non_ascii_tags_come_through_as_they_were_written(fppd, audio):
    """A song whose title and artist have accented, dashed and CJK characters
    is reported with them intact in the playlist status (mediaTitle and
    mediaArtist), not as question marks or Latin-1 mojibake.

    Regression: 2b9547555. TagLib's toCString() without the unicode flag
    gives Latin-1: every character past U+00FF was lost, and the rest
    were mis-encoded when the string was sent on as UTF-8."""
    path = os.path.join(fppd.media, "music", "Tagged.wav")
    write_tone_wav(path, 20)
    tag_wav(path, TIT2=TITLE, TPE1=ARTIST)
    d = plugin(fppd, types="media")
    fppd.write("playlists/Tagged.json", playlist("Tagged", [
        {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Tagged.wav"}]))
    fppd.start()
    fppd.command("Start Playlist", "Tagged", "false", "false")

    def heard():
        try:
            with open(os.path.join(d, "events.log"), encoding="utf-8") as f:
                return [json.loads(l[len("media --data "):]) for l in f if l.startswith("media --data ")]
        except FileNotFoundError:
            return []

    got = fppd.wait_for(heard, what="the plugin's media callback")[0]
    fppd.command("Stop Now")
    assert (got.get("title"), got.get("artist")) == (TITLE, ARTIST), got
