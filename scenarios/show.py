"""Build a small show in a scenario's media directory: a sequence, a playlist
that plays it, and a DDP output to a receiver on this machine."""

import os

from fseq import write_fseq

CHANNELS = 150


def ddp_output(channels=CHANNELS, address="127.0.0.1"):
    """co-universes.json: one DDP output (one-based: the controller's channel
    1 is the output's first channel). "monitor": 0, or fppd pings it."""
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": channels,
        "universes": [{"active": 1, "description": "test controller", "id": 64001,
                       "startChannel": 1, "channelCount": channels, "type": 5,
                       "address": address, "priority": 0, "monitor": 0,
                       "deDuplicate": 0}],
    }]}


def sequence_entry(name):
    return {"type": "sequence", "enabled": 1, "playOnce": 0, "sequenceName": name}


def playlist(name, main, lead_in=(), lead_out=(), repeat=0):
    return {"name": name, "repeat": repeat, "loopCount": 0, "leadIn": list(lead_in),
            "mainPlaylist": list(main), "leadOut": list(lead_out)}


def install(fppd, frames, seq="Show.fseq", playlist_name="Show", step_ms=50, **fseq_args):
    """Sequence + one-entry playlist + DDP output. The bridge inputs are
    turned off so fppd doesn't hold the DDP port the receiver needs."""
    write_fseq(os.path.join(fppd.media, "sequences", seq), frames, step_ms=step_ms, **fseq_args)
    fppd.write(f"playlists/{playlist_name}.json", playlist(playlist_name, [sequence_entry(seq)]))
    fppd.write("config/co-universes.json", ddp_output(len(frames[0])))
    fppd.settings(DisableFakeNetworkBridges="1")


def status(fppd):
    return fppd.get("/fppd/status")
