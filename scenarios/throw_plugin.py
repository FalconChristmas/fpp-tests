"""A compiled (C++) plugin that throws, for test_plugin_native.py: built from
tools/throwplugin.cpp against the tree under test as fseq.fseqgen() builds its
helper, and installed in a scenario's media directory the way fppd finds one:
plugins/<name>/lib<name>.so next to a callbacks script that answers "c++" to
--list. (native_plugin.py builds the feature-flagged nativeplugin.cpp that
test_native_plugins.py uses.)"""

import os
import shutil
import subprocess
import tempfile

from fseq import _sanitizer_flags

_BUILT = {}

CALLBACKS = """#!/bin/sh
case "$1" in
    --list) echo "c++" ;;
esac
"""


def build(source, name):
    """lib<name>.so built from tools/<source>, once per run."""
    if (source, name) in _BUILT:
        return _BUILT[(source, name)]
    src = os.path.join(os.environ["FPP_TREE"], "src")
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(tempfile.mkdtemp(prefix="plugin-"), f"lib{name}.so")
    cmd = ["c++", "-std=gnu++20", "-O1", "-g", "-fPIC", "-shared",
           *_sanitizer_flags(os.path.join(src, "libfpp.so")),
           f"-I{src}", "-I/usr/include/jsoncpp", os.path.join(here, "tools", source),
           f"-L{src}", "-lfpp", "-ldrogon", "-ltrantor", f"-Wl,-rpath,{src}", "-o", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"building {source} failed:\n" + r.stderr[-4000:])
    _BUILT[(source, name)] = out
    return out


def install(fppd, source="throwplugin.cpp", name="fpp-throw"):
    """Install the plugin built from tools/<source> as plugins/<name>;
    return its directory."""
    so = build(source, name)
    d = os.path.join(fppd.media, "plugins", name)
    os.makedirs(d, exist_ok=True)
    shutil.copy(so, os.path.join(d, f"lib{name}.so"))
    script = os.path.join(d, "callbacks")
    with open(script, "w") as f:
        f.write(CALLBACKS)
    os.chmod(script, 0o755)
    return d
