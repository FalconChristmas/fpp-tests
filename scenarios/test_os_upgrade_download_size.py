"""upgradeOS-part1.sh's check of the downloaded image against GitHub's size
for it, run on its own in the fppinit sandbox. The script asks the player's
own api/git/releases/sizes (a stand-in on 127.0.0.1:80 here) for the image's
size: a download smaller than that is deleted and refused, one that matches
carries on to the rest of the upgrade.
"""

import http.server
import threading

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

IMAGE = "Pi64-9.9.fppos"
UPLOAD = "upload/" + IMAGE


class Sizes:
    """The player's /api/git/releases/sizes: "<image>,<bytes>" lines."""

    def __init__(self, text, stall=False):
        body = text.encode()
        self.requests = []
        self.release = threading.Event()
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer.requests.append(self.path)
                if stall:  # a lookup GitHub never answers
                    outer.release.wait(300)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        try:
            self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 80), H)
        except OSError as e:
            pytest.skip(f"cannot stand in for the player on 127.0.0.1:80: {e}")
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


def apply(fppinit, size, github, listing=None, stall=False, timeout=120):
    fppinit.write_bytes(UPLOAD, b"x" * size)
    sizes = Sizes(listing if listing is not None else f"Pi-9.9-other.fppos,1\n{IMAGE},{github}\n", stall=stall)
    try:
        r = fppinit._run(["/opt/fpp/SD/upgradeOS-part1.sh", f"/home/fpp/media/{UPLOAD}"],
                         timeout=timeout, media_home=True)
    finally:
        sizes.close()
    # The control: the script got as far as asking, so what follows is its answer.
    assert sizes.requests == ["/api/git/releases/sizes"], (sizes.requests, r.stdout + r.stderr)
    return r, r.stdout + r.stderr


def test_a_download_smaller_than_githubs_is_deleted_and_refused(fppinit):
    """Regression: a5b1a6ae7 (#1400). A cut-off FPPOS download was applied
    as it was; the script now compares its size with GitHub's and, when it
    is smaller, removes it so the next try fetches it again."""
    r, out = apply(fppinit, 1000, 5000)
    assert "Download size seems too small. Our size: 1000, Github size: 5000" in out, out[-3000:]
    assert r.returncode == 1, out[-3000:]
    assert not fppinit.media_exists(UPLOAD), "the short download was kept"


def test_a_download_of_githubs_size_goes_on_to_the_upgrade(fppinit):
    r, out = apply(fppinit, 5000, 5000)
    assert "fppos size matches Github, continuing" in out, out[-3000:]
    assert "too small" not in out
    assert fppinit.media_exists(UPLOAD), "a complete download was removed"


def test_another_image_whose_name_holds_this_ones_does_not_skip_the_check(fppinit):
    """Regression: f14f1aa27. The image's line was found with grep -F, so
    an image whose name has this one's in it (BBB-Pi64-9.9.fppos for
    Pi64-9.9.fppos) matched too: the size read back was two numbers, not
    one, the check was skipped as if offline, and a cut-off download was
    applied. Now the line must name the image whole."""
    r, out = apply(fppinit, 1000, 5000, listing=f"BBB-{IMAGE},99999\n{IMAGE},5000\n")
    assert "Download size seems too small. Our size: 1000, Github size: 5000" in out, out[-3000:]
    assert r.returncode == 1, out[-3000:]
    assert not fppinit.media_exists(UPLOAD), "the short download was kept"


def test_a_size_lookup_that_never_answers_does_not_hold_the_upgrade(fppinit):
    """Regression: f14f1aa27. The lookup (the player's API, which asks
    api.github.com) had no time limit, so a stalled connection held the
    upgrade at "Verifying image" for good. It now gives up after 45 s and
    goes ahead, as it does offline."""
    r, out = apply(fppinit, 5000, 5000, stall=True, timeout=100)
    assert "Couldn't get fppos size from Github, attempting upgrade anyway" in out, out[-3000:]
    assert fppinit.media_exists(UPLOAD), "the download was removed"
