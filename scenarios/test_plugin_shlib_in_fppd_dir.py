"""A plugin library asked for by name that is in fppd's own directory tree
but fails to load. The asking is a native test plugin's
(findpluginplugin.cpp, built by plugin_build.py): nothing in the tree itself
calls PluginManager::findPlugin(), which is for code outside it."""

import os

import plugin_build


def test_a_library_next_to_fppd_that_will_not_load_is_not_reported_missing(fppd):
    """findPlugin() for a library that is in fppd's directory tree but cannot
    be loaded (here, not a shared object at all) logs that it failed to load,
    not "Failed to find shlib", which says the file is not there.

    Regression: 1c6f0c7e0. The file was looked for only relative to fppd's
    working directory, so a library that exists where fppd looks for it still
    drew "Failed to find shlib" and sent the reader hunting for a file that
    was there. (test_runtime_fixes_70.py checks the message for a library
    that really is missing.)"""
    plugin_build.build_and_install(fppd, "findpluginplugin.cpp", "fpp-find")
    bad = os.path.join(fppd.tree, "libfpp-badlib.so")
    try:
        fppd.start()
        fppd.wait_for(lambda: "fpp-find Find" in {c["name"] for c in fppd.get("/commands")},
                      timeout=15, interval=0.25, what="the plugin to load")
        # The control: a name with no file anywhere is reported missing.
        assert fppd.command("fpp-find Find", "fpp-nolib", timeout=10) == "not found"
        assert "Failed to find shlib libfpp-nolib.so" in fppd.log()
        with open(bad, "w") as f:
            f.write("not a shared object\n")
        assert fppd.command("fpp-find Find", "fpp-badlib", timeout=10) == "not found"
        fppd.wait_for(lambda: "Failed to load shlib: libfpp-badlib.so" in fppd.log(), timeout=15,
                      what="the bad library's load failure to be logged")
        assert "Failed to find shlib libfpp-badlib.so" not in fppd.log()
    finally:
        if os.path.exists(bad):
            os.remove(bad)
