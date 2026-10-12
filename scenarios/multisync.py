"""FPP's MultiSync control protocol (docs/ControlProtocol.txt in fpp)."""

import struct
from dataclasses import dataclass

PORT = 32320
TYPE_SYNC = 0x01
ACTIONS = {0: "start", 1: "stop", 2: "sync", 3: "open"}
FILE_TYPES = {0: "fseq", 1: "media"}


@dataclass
class Sync:
    time: float
    action: str
    file_type: str
    frame: int
    seconds: float
    filename: str


def parse_sync(t, payload):
    """A MultiSync sync packet, or None for any other control packet."""
    if len(payload) < 17 or payload[:4] != b"FPPD" or payload[4] != TYPE_SYNC:
        return None
    action, ftype = payload[7], payload[8]
    frame, seconds = struct.unpack("<If", payload[9:17])
    name = payload[17:].split(b"\0", 1)[0].decode(errors="replace")
    return Sync(t, ACTIONS.get(action, f"?{action}"), FILE_TYPES.get(ftype, f"?{ftype}"),
                frame, seconds, name)


def sync_packet(action, file_type, frame, seconds, filename):
    """Build one, to drive an fppd in remote mode."""
    code = {v: k for k, v in ACTIONS.items()}[action]
    ftype = {v: k for k, v in FILE_TYPES.items()}[file_type]
    extra = struct.pack("<BBIf", code, ftype, frame, seconds) + filename.encode() + b"\0"
    return b"FPPD" + bytes([TYPE_SYNC]) + struct.pack("<H", len(extra)) + extra
