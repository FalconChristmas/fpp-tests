"""LD_PRELOAD shims for fppd, built from the C files next to this module."""

import hashlib
import os
import shutil
import subprocess
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


def build(source, libs=("-ldl",)):
    """The shared object built from scenarios/<source>, once per version of
    the source. Skips the test where there is no compiler."""
    path = os.path.join(HERE, source)
    with open(path, "rb") as f:
        tag = hashlib.sha1(f.read()).hexdigest()[:12]
    stem = os.path.splitext(source)[0]
    so = os.path.join(tempfile.gettempdir(), f"{stem}-{tag}.so")
    if not os.path.exists(so):
        if not shutil.which("gcc"):
            pytest.skip(f"gcc is needed to build {source}")
        tmp = so + f".{os.getpid()}"
        subprocess.run(["gcc", "-shared", "-fPIC", "-O2", "-o", tmp, path, *libs], check=True)
        os.rename(tmp, so)
    return so
