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
