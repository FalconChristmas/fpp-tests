"""fppoled with a display a test can read: a fake SSD1306 on the I2C bus
(fakessd1306.c) and a decoder for the frames it records.

fppoled draws text in the built-in 5x7 font, six pixels a character, and
the status page puts its lines on 8-pixel rows, so a line of text is one
GDDRAM page and a character is five of its bytes: `Frame.lines()` reads
them back with the font table from the tree under test's SSD1306_OLED.c.
"""

import os
import re
import signal
import subprocess
import threading
import time

import shims


def font(tree):
    """The 5x7 font of the tree under test, as {five column bytes: char}."""
    src = open(os.path.join(tree, "src", "oled", "SSD1306_OLED.c")).read()
    body = src.split("ssd1306_font5x7[] = {", 1)[1].split("};", 1)[0]
    body = re.sub(r"//[^\n]*|/\*.*?\*/", "", body, flags=re.S)
    data = [int(t, 16) for t in re.findall(r"0x[0-9A-Fa-f]{2}", body)]
    glyphs = {}
    for c in range(32, 127):
        g = bytes(data[c * 5:c * 5 + 5])
        glyphs.setdefault(g, chr(c))
    return glyphs


class Frame:
    def __init__(self, ms, data, glyphs):
        self.ms = ms
        self.data = data
        self.glyphs = glyphs

    def pixel(self, x, y):
        return (self.data[(y // 8) * 128 + x] >> (y % 8)) & 1

    def page(self, p):
        return self.data[p * 128:(p + 1) * 128]

    def row(self, y):
        """Rows y..y+7 as 128 column bytes, bit 0 on top, the way a
        character's font bytes are laid out."""
        if y % 8 == 0:
            return self.page(y // 8)
        return bytes(sum(self.pixel(x, y + j) << j for j in range(8) if y + j < 64)
                     for x in range(128))

    def line(self, p):
        """The text on page p (rows 8p..8p+7)."""
        return self.text_at(8 * p)

    def text_at(self, y):
        """The text whose top is row y, read at whichever of the six
        character alignments reads the most characters."""
        row = self.row(y)
        blank = bytes(5)
        best, score = "", -1
        for off in range(6):
            out, good = [], 0
            for x in range(off, 128 - 4, 6):
                cell = row[x:x + 5]
                if cell == blank:
                    out.append(" ")
                elif cell in self.glyphs:
                    out.append(self.glyphs[cell])
                    good += 1
                else:
                    out.append("?")
                    good -= 1
            if good > score:
                best, score = "".join(out).strip(), good
        return best

    def lines(self):
        return [self.line(p) for p in range(8)]

    def text(self):
        return "\n".join(self.lines())


class Fppoled:
    """One fppoled run against the fake display. The settings (LEDDisplayType
    1, a plain 128x64 SSD1306) are the caller's to write, in fppoled's
    /home/fpp/media."""

    def __init__(self, tree, workdir):
        self.tree = tree
        self.out = os.path.join(workdir, "oled-frames.txt")
        self.glyphs = font(tree)
        self.proc = None
        self.output = []

    def start(self, preload=(), extra_env=None):
        if os.path.exists(self.out):
            os.remove(self.out)
        src = os.path.join(self.tree, "src")
        env = dict(os.environ, LD_LIBRARY_PATH=src, FAKESSD1306_OUT=self.out)
        env["LD_PRELOAD"] = " ".join([shims.build("fakessd1306.c"), *preload])
        if extra_env:
            env.update(extra_env)
        self.started = time.monotonic()
        self.proc = subprocess.Popen([os.path.join(src, "fppoled")], stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, env=env,
                                     start_new_session=True)
        threading.Thread(target=lambda: self.output.extend(self.proc.stdout), daemon=True).start()

    def records(self):
        try:
            with open(self.out) as f:
                rows = [l.split() for l in f if l.endswith("\n")]
        except FileNotFoundError:
            return []
        return rows

    def frames(self):
        return [Frame(int(r[1]), bytes.fromhex(r[2]), self.glyphs)
                for r in self.records() if r[0] == "F" and len(r) == 3 and len(r[2]) == 2048]

    def commands(self):
        return [(int(r[1]), r[2]) for r in self.records() if r[0] == "C"]

    def wait_for(self, predicate, timeout=20, what="the display"):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            frames = self.frames()
            last = frames[-1].text() if frames else None
            for f in reversed(frames):
                if predicate(f):
                    return f
            if self.proc.poll() is not None:
                raise AssertionError(f"fppoled exited {self.proc.returncode} waiting for {what}\n"
                                     f"{self.log()}")
            time.sleep(0.2)
        raise AssertionError(f"timed out after {timeout}s waiting for {what}; last frame:\n{last}\n"
                             f"{self.log()}")

    def stop(self, timeout=10):
        """SIGTERM fppoled; returns its exit status (None if it had to be
        killed)."""
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
                return None
        return self.proc.returncode

    def log(self):
        return "".join(self.output)[-3000:]
