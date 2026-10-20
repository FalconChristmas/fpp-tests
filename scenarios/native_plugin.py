"""Install nativeplugin.cpp as a native (C++) plugin, built against the tree
under test with the sanitizer libfpp carries, the way a plugin's own Makefile
builds it on a player."""

import os
import subprocess

from fseq import _sanitizer_flags
from test_plugin_scripts import plugin

HERE = os.path.dirname(os.path.abspath(__file__))


def install(fppd, name="fpp-native", features=()):
    """Build the plugin with the given NATIVE_* features into
    plugins/<name>/lib<name>.so, with the callbacks script that tells fppd
    it is a C++ plugin; return its directory."""
    d = plugin(fppd, name=name, types="c++")
    src = os.path.join(os.environ["FPP_TREE"], "src")
    cmd = ["c++", "-std=gnu++20", "-O1", "-g", "-fPIC", "-shared",
           *_sanitizer_flags(os.path.join(src, "libfpp.so")),
           f'-DPLUGIN_NAME="{name}"', *[f"-D{f}" for f in features],
           f"-I{src}", "-I/usr/include/jsoncpp", os.path.join(HERE, "nativeplugin.cpp"),
           f"-L{src}", "-lfpp", f"-Wl,-rpath,{src}", "-o", os.path.join(d, f"lib{name}.so")]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("building the native plugin failed:\n" + r.stderr[-4000:])
    return d
