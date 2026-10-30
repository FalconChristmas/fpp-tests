"""Warnings raised by a native plugin (warnplugin.cpp) through WarningHolder,
and the two ways fppd lists them: /api/fppd/warnings, the messages alone as
in 7.x, and /api/fppd/warnings_full, each warning with its id, its plugin and
its data."""

import os
import subprocess

import native_plugin

NAME = "fpp-warntest"


def start(fppd):
    native_plugin.install(fppd, name=NAME, source="warnplugin.cpp")
    fppd.start()


def full(fppd, message):
    return [w for w in fppd.get("/fppd/warnings_full") if w.get("message") == message]


def test_warnings_lists_messages_and_warnings_full_the_whole_warning(fppd):
    """A warning a plugin raises with an id under its own name is in
    /fppd/warnings as its message string, and in /fppd/warnings_full with
    the id and the plugin's name.

    Regression: 7f9f40acc. Once warnings carried ids (b2e1dc9ce),
    /fppd/warnings answered with the objects, which broke what read it as
    the 7.x list of strings; the objects moved to warnings_full.
    Regression: 0e671acb0. A warning had no plugin field to say which plugin
    raised it."""
    start(fppd)
    fppd.command("Warning Test Add", "9001", "fpp-tests plugin warning", NAME)
    fppd.wait_for(lambda: full(fppd, "fpp-tests plugin warning"), timeout=10,
                  what="the plugin's warning in warnings_full")
    plain = fppd.get("/fppd/warnings")
    assert "fpp-tests plugin warning" in plain, f"/fppd/warnings is not the message list: {plain}"
    assert all(isinstance(w, str) for w in plain), plain
    [w] = full(fppd, "fpp-tests plugin warning")
    assert w.get("id") == 9001 and w.get("plugin") == NAME, w


def test_the_same_warning_raised_again_is_listed_once(fppd):
    """Raising a warning that is already up (same id, same message) leaves
    one copy, and removing it takes it down.

    Regression: 3b58fe1ca. Each raise appended another copy, so a warning
    re-raised on every check filled the banner with repeats."""
    start(fppd)
    for _ in range(3):
        fppd.command("Warning Test Add", "9002", "fpp-tests repeated warning", NAME)
    fppd.wait_for(lambda: full(fppd, "fpp-tests repeated warning"), timeout=10,
                  what="the repeated warning in warnings_full")
    got = full(fppd, "fpp-tests repeated warning")
    assert len(got) == 1, f"{len(got)} copies: {got}"
    fppd.command("Warning Test Remove", "9002", "fpp-tests repeated warning", NAME)
    fppd.wait_for(lambda: not full(fppd, "fpp-tests repeated warning"), timeout=10,
                  what="the warning to be removed")


SEVEN_X_API = {
    "_ZN13WarningHolder10AddWarningERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE":
        "AddWarning(const std::string&)",
    "_ZN13WarningHolder17AddWarningTimeoutERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEEi":
        "AddWarningTimeout(const std::string&, int)",
    "_ZN13WarningHolder13RemoveWarningERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE":
        "RemoveWarning(const std::string&)",
}


def test_libfpp_still_exports_the_7x_warning_calls():
    """libfpp.so defines WarningHolder's 7.x calls, the message-only
    AddWarning, AddWarningTimeout and RemoveWarning, so a plugin binary
    built against 7.x still loads.

    Regression: 831830eab. When warnings gained ids (b2e1dc9ce) these became
    inline wrappers in Warnings.h, compiled into each caller and no longer
    exported, and a 7.x plugin failed to load on the missing symbol."""
    so = os.path.join(os.environ["FPP_TREE"], "src", "libfpp.so")
    out = subprocess.run(["nm", "-D", "--defined-only", so], capture_output=True, text=True,
                         check=True).stdout
    defined = {l.split()[-1] for l in out.splitlines() if len(l.split()) >= 3}
    missing = [name for sym, name in SEVEN_X_API.items() if sym not in defined]
    assert not missing, f"libfpp.so no longer exports WarningHolder::{', '.join(missing)}"
