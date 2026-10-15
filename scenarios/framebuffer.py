"""A fake /dev/fbN for fppd's IOCTLFrameBuffer (see fakefb.c).

fppd opens "<framebufferControlSocketPath>/<device>", so the device is an
ordinary file in the media directory: fppd mmap()s it and draws into it, and
fakefb.so, preloaded into fppd, answers the fbdev ioctls for it. A test
reads the pixels back out of the file.
"""

import hashlib
import os
import shutil
import subprocess
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "fakefb.c")


def shim():
    """fakefb.so, built once per version of its source."""
    with open(SOURCE, "rb") as f:
        tag = hashlib.sha1(f.read()).hexdigest()[:12]
    so = os.path.join(tempfile.gettempdir(), f"fakefb-{tag}.so")
    if not os.path.exists(so):
        if not shutil.which("gcc"):
            pytest.skip("gcc is needed to build the fake framebuffer")
        tmp = so + f".{os.getpid()}"
        subprocess.run(["gcc", "-shared", "-fPIC", "-O2", "-o", tmp, SOURCE, "-ldl", "-lpthread"], check=True)
        os.rename(tmp, so)
    return so


class FakeFb:
    """One fake framebuffer device.

    width, height, bpp: the mode the "driver" reports.
    pages:              how many pages of video memory it has.
    fixed:              behave like fbtft (mode changes are ignored).
    """

    def __init__(self, fppd, name="fb1", width=64, height=32, bpp=32, pages=3, fixed=False):
        self.fppd = fppd
        self.name = name
        self.dir = os.path.join(fppd.media, "fakefb")
        os.makedirs(self.dir, exist_ok=True)
        self.path = os.path.join(self.dir, name)
        self.geom = (width, height, bpp)
        self.fixed = fixed
        with open(self.path, "wb") as f:
            f.truncate(width * height * (bpp // 8) * pages)

    def start(self, **kw):
        self.fppd.settings(framebufferControlSocketPath=self.dir)
        self.fppd.start(preload=[shim()], extra_env={
            "FAKEFB_DIR": self.dir,
            "FAKEFB_GEOM": "%dx%dx%d" % self.geom,
            "FAKEFB_FIXED": "1" if self.fixed else "0",
        }, **kw)

    def mode(self):
        """(xres, yres, xres_virtual, yres_virtual, bpp, yoffset) as fppd last
        set it, or None before fppd opened the device."""
        try:
            with open(self.path + ".var") as f:
                return tuple(int(v) for v in f.read().split())
        except (FileNotFoundError, ValueError):
            return None

    def page(self, index=None):
        """The rows of a page, as (bytes per pixel, [row bytes]): the page on
        screen unless `index` is given."""
        xres, yres, xv, yv, bpp, yoffset = self.mode()
        bpp_bytes = bpp // 8
        line = xv * bpp_bytes
        first = yoffset if index is None else index * yres
        with open(self.path, "rb") as f:
            f.seek(first * line)
            data = f.read(yres * line)
        return bpp_bytes, [data[y * line:(y + 1) * line] for y in range(yres)]

    def pixels(self, index=None):
        """The page as rows of (r, g, b)."""
        bpp_bytes, rows = self.page(index)
        out = []
        for row in rows:
            px = []
            for x in range(0, len(row) - bpp_bytes + 1, bpp_bytes):
                if bpp_bytes == 2:
                    v = row[x] | row[x + 1] << 8
                    px.append(((v >> 11) << 3, ((v >> 5) & 0x3F) << 2, (v & 0x1F) << 3))
                else:
                    px.append((row[x + 2], row[x + 1], row[x]))  # BGR(A) in memory
            out.append(px)
        return out
