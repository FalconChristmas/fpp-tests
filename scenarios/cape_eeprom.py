"""Cape EEPROM images, built from the format CapeUtils parses.

An image is a header -- "FPP02" padded to 6 bytes, then the cape's name
(26 bytes), version (10) and serial number (16), each NUL-padded -- and then
records until a zero length:

    length (6 bytes, ASCII decimal, NUL-padded)
    type   (2 bytes, ASCII decimal)
    path   (64 bytes, only for a type below 50: where the data is written,
            relative to the extraction directory)
    data   (length bytes)

Types used here: 0 a plain file, 2 a .tgz unpacked where it lands (the
cape's files: cape-info.json and friends, which become media/tmp), 97 a
key/value extra (a 12-byte key, then the value), 98 where the image may be
used from ("0" anywhere, "1" a real EEPROM, "2" a virtual one in
media/config), 99 a signature (a 6-byte key id, then the bytes).

Nothing here can sign: the images are unsigned, or carry a signature that
does not verify. That is what a cape EEPROM uploaded by anyone looks like,
and it is the case the restrictions in CapeUtils exist for.
"""

import io
import json
import tarfile
import time


def record(code, data, path=None):
    if isinstance(data, str):
        data = data.encode()
    out = str(len(data)).encode().ljust(6, b"\0") + str(code).encode().ljust(2, b"\0")
    if code < 50:
        out += (path or "").encode().ljust(64, b"\0")
    return out + data


def raw_record(length, code, path=None, data=b""):
    """A record whose length field says what the caller wants, whatever
    follows it."""
    out = str(length).encode().ljust(6, b"\0") + str(code).encode().ljust(2, b"\0")
    if code < 50:
        out += (path or "").encode().ljust(64, b"\0")
    return out + data


def tgz(files, links=None):
    """A .tgz of {name: content}; a dict or list is written as JSON.
    links: {name: target} symlinks."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        dirs = set()
        for name in list(files) + list(links or {}):
            parts = name.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                dirs.add("/".join(parts[:i]))
        for d in sorted(dirs):
            info = tarfile.TarInfo(d)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.mtime = int(time.time())
            t.addfile(info)
        for name, content in files.items():
            if isinstance(content, (dict, list)):
                content = json.dumps(content)
            if isinstance(content, str):
                content = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o644
            info.mtime = int(time.time())
            t.addfile(info, io.BytesIO(content))
        for name, target in (links or {}).items():
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE
            info.linkname = target
            info.mtime = int(time.time())
            t.addfile(info)
    return buf.getvalue()


def header(name="TestCape", version="1.0", serial="TEST0001"):
    return (b"FPP02".ljust(6, b"\0") + name.encode().ljust(26, b"\0")
            + version.encode().ljust(10, b"\0") + serial.encode().ljust(16, b"\0"))


END = b"0".ljust(6, b"\0")


def image(cape_info, files=None, links=None, location=None, signature=None, extras=None,
          name="TestCape", serial="TEST0001"):
    """An unsigned image whose archive holds cape-info.json plus `files`.

    location: the type-98 value, or None for no record.
    signature: (key id, bytes) for a type-99 record that will not verify.
    extras: {key: value} type-97 records."""
    out = header(name=name, serial=serial)
    for k, v in (extras or {}).items():
        out += record(97, k.encode().ljust(12, b"\0") + v.encode())
    if signature is not None:
        key, sig = signature
        out += record(99, key.encode().ljust(6, b"\0") + sig)
    if location is not None:
        out += record(98, str(location).encode().ljust(2, b"\0"))
    archive = dict(files or {})
    archive["cape-info.json"] = cape_info
    out += record(2, tgz(archive, links), path="tmp/cape-info.tgz")
    return out + END


def cape_info(**kw):
    info = {"id": "TestCape", "name": "Test Cape", "version": "1.0",
            "description": "a cape made up by the test suite", "designer": "fpp-tests"}
    info.update(kw)
    return info
