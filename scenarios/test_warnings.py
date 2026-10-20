"""fppd's warnings (WarningHolder): the banner list every page shows, which
fppd writes to www/warnings.json on its warnings thread."""

import os
import time

import shims


def test_warning_changes_do_not_wait_for_the_warnings_file(fppd):
    """Raising and clearing a warning (here the debug-logging one, by
    setting the log level through the API) doesn't wait while the warnings
    thread writes warnings.json, however slow that write is.

    Regression: 3a52e4ffb. WriteWarningsFile held warningsLock across both
    file writes, so every AddWarning/RemoveWarning -- some on the output and
    media timing paths -- waited for the SD card. Here each write takes 3 s
    and the API call that clears the warning took up to 6."""
    arm = os.path.join(fppd.media, "tmp", "slowwarnings-armed")
    fppd.start(preload=[shims.build("slowwarnings.c")],
               extra_env={"SLOWWARN_ARM": arm, "SLOWWARN_MS": "3000"})
    open(arm, "w").close()
    took = []
    try:
        for level in ("debug", "info") * 3:
            began = time.monotonic()
            fppd.post(f"/fppd/log/level/{level}", timeout=30)
            took.append(time.monotonic() - began)
            time.sleep(0.3)  # the warnings thread is writing the change by now
    finally:
        os.unlink(arm)
    assert max(took) < 1.5, f"setting the log level took {', '.join(f'{t:.1f}' for t in took)} s"


DEBUG_WARNING = "A Log Level is set to Debug"
EXCESSIVE_WARNING = "A Log Level is set to Excessive"


def log_level_warnings(fppd):
    """The log-level warnings fppd has up right now, by their text."""
    found = set()
    for w in fppd.get("/fppd/warnings"):
        text = w.get("message", "") if isinstance(w, dict) else str(w)
        for msg in (DEBUG_WARNING, EXCESSIVE_WARNING):
            if msg in text:
                found.add(msg)
    return found


def test_setting_the_log_level_through_the_api_updates_its_warning(fppd):
    """Setting a log level to Debug or Excessive through the API raises the
    matching warning (one channel is enough), changing it swaps the
    warning, and going back to Info takes it down.

    Regression: 21c0bfefc. Only the command socket (and fppd's startup)
    recomputed these warnings, so a level changed through
    POST /api/fppd/log/level -- the Logging settings page among others --
    left the banner showing the level fppd had started with."""
    fppd.start()
    assert log_level_warnings(fppd) == set(), "a log-level warning before any change"
    steps = [("debug:Sync", {DEBUG_WARNING}),
             ("excess", {EXCESSIVE_WARNING}),
             ("debug", {DEBUG_WARNING}),
             ("info", set())]
    for level, want in steps:
        fppd.post(f"/fppd/log/level/{level}")
        fppd.wait_for(lambda: log_level_warnings(fppd) == want, timeout=10,
                      what=f"the warnings to be {sorted(want)} after level {level} "
                           f"(have {sorted(log_level_warnings(fppd))})")


def test_lowering_a_debug_level_set_at_startup_clears_its_warning(fppd):
    """A Debug level from the settings file raises the warning when fppd
    starts; lowering it through the API takes the warning down.

    Regression: 21c0bfefc (see above): the startup warning stayed up."""
    fppd.settings(LogLevel_Sync="debug")
    fppd.start()
    # The control: the startup check raised it.
    fppd.wait_for(lambda: log_level_warnings(fppd) == {DEBUG_WARNING}, timeout=10,
                  what="the debug warning at startup")
    fppd.post("/fppd/log/level/info")
    fppd.wait_for(lambda: log_level_warnings(fppd) == set(), timeout=10,
                  what=f"the warning to go (have {sorted(log_level_warnings(fppd))})")
