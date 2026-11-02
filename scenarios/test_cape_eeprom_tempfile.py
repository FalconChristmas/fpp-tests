"""generateEEPROM's scratch file while it packs a cape directory."""

import os

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_cape_eeprom_generate import generate


def test_packing_a_cape_uses_its_own_scratch_file_and_removes_it(fppinit, tmp_path):
    """The directory handed to generateEEPROM -d is packed into a scratch
    file in the working directory; it must be one of its own, gone afterwards.

    Regression: ecf0a27a5. The scratch file was a fixed ./tempfile that was
    never removed: every run left one behind in the directory it was run
    from, and wrote over (and left) a file of that name already there.
    """
    mine = tmp_path / "tempfile"
    mine.write_bytes(b"not the tool's file\n")
    generate(tmp_path)
    # The receiving end is the image the tool wrote: it must hold the packed
    # directory (generate() asserts a non-empty image), and the tool must
    # have left only the files that were there plus what it was asked for.
    assert mine.read_bytes() == b"not the tool's file\n", "the tool used ./tempfile"
    left = sorted(n for n in os.listdir(tmp_path) if n.startswith("tempfile") and n != "tempfile")
    assert left == [], f"the tool left its scratch file behind: {left}"
