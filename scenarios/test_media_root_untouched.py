"""www/media_root.txt, the file that names the media directory, is written
only when it has to change."""

import os
import sys


def test_fppd_leaves_an_unchanged_media_root_file_alone(fppd):
    """Starting fppd with www/media_root.txt already naming the media
    directory doesn't write the file again.

    Regression: f76e6a5be (#1530). Every start rewrote the file with the
    directory it had just read from it; the file is only meant to be written
    at install time."""
    path = os.path.join(fppd.tree, "www", "media_root.txt")
    # fppd.start() writes the file first, so write it here and age it in the
    # command that execs fppd, a moment before fppd reads it.
    fppd.start(argv=[sys.executable, "-c",
                     "import os, sys; p = sys.argv[1]; open(p, 'w').write(sys.argv[2]); "
                     "os.utime(p, (1_000_000_000, 1_000_000_000)); os.execv(sys.argv[3], sys.argv[3:])",
                     path, fppd.media, os.path.join(fppd.tree, "src", "fppd"), "-f"])
    assert os.path.getmtime(path) == 1_000_000_000, "fppd rewrote an unchanged media_root.txt"
    with open(path) as f:
        assert f.read() == fppd.media
