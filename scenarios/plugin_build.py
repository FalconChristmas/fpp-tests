"""Native (C++) plugins built the ways the plugin ABI and lifecycle scenarios
need: against the tree's headers or a modified copy of them, under a plugin
name that differs from its directory, through the tree's own plugin
makefile fragment (makefiles/common/setup.mk) as a plugin's Makefile builds
it on a player -- and installed where fppd finds one:
plugins/<dir>/lib<dir>.so next to a callbacks script that answers "c++".

native_plugin.py builds the feature-flagged nativeplugin.cpp; this is for
plugins whose build itself is what a scenario tests."""

import os
import re
import shutil
import subprocess
import tempfile

from fseq import _sanitizer_flags
from test_plugin_scripts import plugin

HERE = os.path.dirname(os.path.abspath(__file__))


def tree_src():
    return os.path.join(os.environ["FPP_TREE"], "src")


def api_version():
    """FPP_PLUGIN_API_VERSION in the tree under test."""
    with open(os.path.join(tree_src(), "Plugin.h")) as f:
        return int(re.search(r"#define FPP_PLUGIN_API_VERSION (\d+)", f.read()).group(1))


def build(source, out, defines=(), include_first=(), extra=(), lang="c++", sanitize=True):
    """Compile `source` (a file in this directory, or an absolute path) into
    the shared object `out`, against the tree's headers and libfpp.
    include_first: directories searched ahead of the tree's src/ (a header
    copy with a changed layout). Raises with the compiler's output if it
    does not build; returns `out`."""
    src = tree_src()
    path = source if os.path.isabs(source) else os.path.join(HERE, source)
    if lang == "c++":
        cmd = ["c++", "-std=gnu++20", "-O1", "-g"]
    else:
        cmd = ["cc", "-O1", "-g"]
    if sanitize:
        cmd += _sanitizer_flags(os.path.join(src, "libfpp.so"))
    cmd += ["-fPIC", "-shared", *[f"-D{d}" for d in defines],
            *[f"-I{d}" for d in include_first], f"-I{src}", "-I/usr/include/jsoncpp",
            *extra, path, f"-L{src}", "-lfpp", f"-Wl,-rpath,{src}", "-o", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"building {os.path.basename(path)} failed:\n" + r.stderr[-4000:])
    return out


def install(fppd, dirname, so=None):
    """plugins/<dirname> with a callbacks script that says it is a C++
    plugin, and `so` (if given) copied in as lib<dirname>.so; returns the
    directory."""
    d = plugin(fppd, name=dirname, types="c++")
    if so:
        shutil.copy(so, os.path.join(d, f"lib{dirname}.so"))
    return d


def build_and_install(fppd, source, dirname, plugin_name=None, defines=(), **kw):
    """Build `source` with PLUGIN_NAME set to plugin_name (default: the
    directory name) and install it as plugins/<dirname>."""
    d = install(fppd, dirname)
    name = plugin_name or dirname
    build(source, os.path.join(d, f"lib{dirname}.so"),
          defines=[f'PLUGIN_NAME="{name}"', *defines], **kw)
    return d


MAKEFILE = """SRCDIR ?= /opt/fpp/src
include $(SRCDIR)/makefiles/common/setup.mk
include $(SRCDIR)/makefiles/platform/*.mk

all: lib{name}.$(SHLIB_EXT)

OBJECTS_plugin += plugin.o
LIBS_plugin += -L$(SRCDIR) -lfpp -ljsoncpp
CXXFLAGS_plugin.o += -I$(SRCDIR) {cxxflags}

%.o: %.cpp Makefile
\t$(CC) $(CFLAGS) $(CXXFLAGS) $(CXXFLAGS_$@) -c $< -o $@

lib{name}.$(SHLIB_EXT): $(OBJECTS_plugin) $(SRCDIR)/libfpp.$(SHLIB_EXT)
\t$(CC) -shared $(CFLAGS_$@) $(OBJECTS_plugin) $(LIBS_plugin) $(LDFLAGS) -o $@
"""


def make_build(fppd, source, dirname, defines=()):
    """Build `source` the way a plugin's own Makefile does on a player -- it
    includes the tree's makefiles/common/setup.mk and compiles with the
    CFLAGS that sets for plugins -- and install it as plugins/<dirname>.
    Built without the precompiled header (DISTRIBUTED_COMPILE, as a
    distributed plugin build is) and without a sanitizer, as `make` builds
    one. Returns the directory."""
    d = install(fppd, dirname)
    work = tempfile.mkdtemp(prefix="plugin-make-")
    shutil.copy(os.path.join(HERE, source), os.path.join(work, "plugin.cpp"))
    flags = " ".join([f"-DPLUGIN_NAME=\\\"{dirname}\\\""] + [f"-D{x}" for x in defines])
    with open(os.path.join(work, "Makefile"), "w") as f:
        f.write(MAKEFILE.format(name=dirname, cxxflags=flags))
    r = subprocess.run(["make", "-s", f"SRCDIR={tree_src()}", "DISTRIBUTED_COMPILE=1"],
                       cwd=work, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"make for {source} failed:\n" + (r.stdout + r.stderr)[-4000:])
    shutil.copy(os.path.join(work, f"lib{dirname}.so"), os.path.join(d, f"lib{dirname}.so"))
    return d


def unique_symbols(so):
    """The STB_GNU_UNIQUE symbols `so` defines (nm's "u")."""
    out = subprocess.run(["nm", "-D", "--defined-only", so], capture_output=True, text=True,
                         check=True).stdout
    return [l.split()[-1] for l in out.splitlines() if len(l.split()) >= 3 and l.split()[1] == "u"]


def mapped(fppd, dirname):
    """The executable mappings in fppd's /proc/<pid>/maps of a file from
    plugins/<dirname>/: the library's code, under its own name or the
    private one a reload opens it as. Read-only mappings don't count: a
    sanitizer's symbolizer maps the file's debug sections to read them, and
    those outlive the library."""
    with open(f"/proc/{fppd.proc.pid}/maps") as f:
        return [l.rstrip() for l in f
                if f"/plugins/{dirname}/" in l and "x" in l.split()[1]]


def header_copy(edits):
    """A copy of every header in the tree's src/ with `edits` applied --
    {relative path: [(old, new), ...]}, each old string required to be there
    once -- for building a plugin "against another FPP's headers". All of
    them are copied, not just the edited ones: a header's #include "x.h"
    looks in its own directory first, so Plugin.h left in src/ would find
    the unedited log.h beside it. Returns the directory to put ahead of
    src/ on the include path."""
    src = tree_src()
    out = tempfile.mkdtemp(prefix="plugin-headers-")
    shutil.copytree(src, out, dirs_exist_ok=True,
                    ignore=lambda d, names: [n for n in names if not os.path.isdir(os.path.join(d, n))
                                             and not n.endswith((".h", ".hpp"))])
    for rel, subs in edits.items():
        with open(os.path.join(src, rel)) as f:
            text = f.read()
        for old, new in subs:
            if text.count(old) != 1:
                raise AssertionError(f"{rel}: expected exactly one {old!r} to change")
            text = text.replace(old, new)
        with open(os.path.join(out, rel), "w") as f:
            f.write(text)
    return out
