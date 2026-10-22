"""The fppmm CLI: an overlay model's info, its state, a fill, a channel
range, and raw pixel data copied in from a file."""

import os
import subprocess
import urllib.request

from fppd import API
from test_overlays import matrix, setup


def fppmm(fppd, *args, timeout=20):
    """Run the fppmm built alongside this fppd; return (returncode, stdout)."""
    r = subprocess.run([os.path.join(fppd.tree, "src", "fppmm"), *args], capture_output=True,
                       text=True, timeout=timeout,
                       env=dict(os.environ, LD_LIBRARY_PATH=os.path.join(fppd.tree, "src")))
    return r.returncode, r.stdout + r.stderr


def raw(fppd, model):
    """The model's channel data, as bytes."""
    with urllib.request.urlopen(f"{API}/overlays/model/{model}/data/raw", timeout=10) as r:
        return r.read()


def pattern(n):
    """n bytes that are all different from their neighbours, zeros included
    (a zero byte ended an HTTP body that was sent as a C string)."""
    return bytes((i * 7) % 256 for i in range(n))


def test_info_state_and_fill(fppd):
    setup(fppd, [matrix("M")])
    fppd.start()
    rc, out = fppmm(fppd, "-m", "M")
    assert rc == 0 and "Block Name: M" in out and "Layout    : 10x5" in out, out
    rc, out = fppmm(fppd, "-m", "M", "-o", "on")
    assert rc == 0, out
    assert fppd.get("/overlays/model/M")["isActive"] == 1
    rc, out = fppmm(fppd, "-m", "M", "-s", "200")
    assert rc == 0, out
    fppd.wait_for(lambda: raw(fppd, "M") == bytes([200]) * 150, timeout=5,
                  what="the fill to reach the model's data")


def test_file_is_copied_into_a_model(fppd, tmp_path):
    """`fppmm -m MODEL -f FILE` puts the file's bytes on the model, for an
    RGB and an RGBW model, including one nothing has drawn on yet.

    Regression: fe7c5d7f9. fppmm mapped the model's shared overlay buffer itself, sized
    for 3 bytes a pixel. For a model whose buffer fppd hadn't created yet it
    created an empty one and died of SIGBUS writing to it, and an RGBW
    model's data ran past the mapping.

    The RGBW model takes four bytes a pixel because of f892bc19a; before it
    an overlay model's buffer was RGB whatever its channels a node.
    """
    setup(fppd, [matrix("M"), matrix("W", start=151, width=4, height=2, cpn=4)], channels=200)
    fppd.start()
    for model, n in (("M", 150), ("W", 32)):
        data = pattern(n)
        path = tmp_path / f"{model}.raw"
        path.write_bytes(data)
        rc, out = fppmm(fppd, "-m", model, "-o", "on")
        assert rc == 0, out
        rc, out = fppmm(fppd, "-m", model, "-f", str(path))
        assert rc == 0, f"fppmm -f exited {rc}: {out}"
        fppd.wait_for(lambda: raw(fppd, model) == data, timeout=5,
                      what=f"the file's data on {model}")


def test_unknown_model_or_short_file_is_reported(fppd, tmp_path):
    setup(fppd, [matrix("M")])
    fppd.start()
    path = tmp_path / "short.raw"
    path.write_bytes(b"\x01" * 10)
    rc, out = fppmm(fppd, "-m", "NoSuchModel", "-f", str(path))
    assert rc == 0 and "Could not find model" in out, (rc, out)
    rc, out = fppmm(fppd, "-m", "M", "-f", str(path))
    assert rc == 0 and "Expected 150 bytes" in out, (rc, out)
    rc, out = fppmm(fppd, "-m", "M", "-f", str(tmp_path / "missing.raw"))
    assert rc == 0 and "does not exist" in out, (rc, out)


def test_channel_range(fppd):
    """`fppmm -c START-END -s VALUE` sets a range of channels, and -s -1
    deletes it again."""
    setup(fppd, [])
    fppd.start()
    rc, out = fppmm(fppd, "-c", "1-3", "-s", "77")
    assert rc == 0, out
    rc, out = fppmm(fppd, "-c", "1-3", "-s", "-1")
    assert rc == 0, out
