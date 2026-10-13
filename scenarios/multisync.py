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


def control_packet(ptype, extra, claimed_len=None):
    """Any control packet: 'FPPD', the type, ExtraDataLen (claimed_len to
    lie about it) and the extra data."""
    n = len(extra) if claimed_len is None else claimed_len
    return b"FPPD" + bytes([ptype]) + struct.pack("<H", n & 0xFFFF) + extra


def fpp_command_packet(command, args, host="", nargs=None):
    """An FPP Command packet (0x06). nargs lies about the argument count."""
    extra = bytes([len(args) if nargs is None else nargs]) + host.encode() + b"\0"
    extra += command.encode() + b"\0" + b"".join(a.encode() + b"\0" for a in args)
    return control_packet(0x06, extra)


def _field(value, size):
    """A NUL-padded fixed-size field; bytes are taken as they are, so a test
    can fill one with no terminator."""
    raw = value if isinstance(value, bytes) else value.encode()
    return raw[:size].ljust(size, b"\0")


PING_LEN = {1: 98, 2: 214, 3: 294, 4: 359}


def ping_packet(ip, hostname, version=4, discover=False, type_id=0x01, major=10, minor=0,
                mode=0x02, ver="10.0", model="Test", ranges="", uuid=""):
    """A Ping packet (0x04), laid out as docs/ControlProtocol.txt describes.
    The IP field is what fppd records the system under."""
    extra = bytes([version, 1 if discover else 0, type_id]) + struct.pack(">HH", major, minor)
    extra += bytes([mode]) + bytes(int(o) for o in ip.split("."))
    extra += _field(hostname, 65) + _field(ver, 41)
    if version >= 2:
        extra += _field(model, 41)
        extra += _field(ranges, 41 if version == 2 else 121)
    if version >= 3:
        extra += bytes(14)
    if version >= 4:
        extra += _field(uuid, 65)
    extra = extra[:PING_LEN[version]].ljust(PING_LEN[version], b"\0")
    return control_packet(0x04, extra)
