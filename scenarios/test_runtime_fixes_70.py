"""Fixes from the 6.3 and 7.0 releases that keep fppd or its scripts going
when something is missing or unusual, run as fppd runs them."""


def test_a_plugin_whose_library_is_missing_says_so_in_the_log(fppd):
    """A C++ plugin whose library file is not there is logged as a missing
    shlib, rather than silently skipped.

    Feature: 8387b9154."""
    from test_plugin_scripts import plugin
    plugin(fppd, name="fpp-nolib", types="c++")
    fppd.start()
    fppd.wait_for(lambda: "Failed to find shlib" in fppd.log(), timeout=15, what="the missing shlib to be logged")
