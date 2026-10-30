"""What fppd's command registry leaves behind at shutdown, seen by
LeakSanitizer run at fppd's final _exit() (exitleakcheck.c)."""

import os

import pytest

import shims


def test_shutdown_frees_the_gpio_command(fppd):
    """fppd registers the GPIO command when the build has pins (the TmpFile
    pins in a container); a clean shutdown frees it with every other
    command: LeakSanitizer at the final _exit() finds no FPPGPIOCommand.

    Regression: 52cfbf28b. CommandManager::Cleanup() skipped deleting the
    GPIO command ("no idea why deleting the GPIO command causes a crash on
    exit"), so it leaked at every shutdown."""
    from fppd import sanitizer
    if sanitizer() != "asan":
        pytest.skip("needs LeakSanitizer (an ASan build)")
    lsan = os.path.join(fppd.media, "logs", "lsan")
    fppd.start(preload=[shims.build("exitleakcheck.c")], extra_env={"ASAN_OPTIONS": (
        f"halt_on_error=1:detect_leaks=1:abort_on_error=0:log_path={lsan}")})
    assert "GPIO" in [c["name"] for c in fppd.get("/commands")], "no GPIO command in this build"
    fppd.exit_expected = True
    rc = fppd.stop()
    assert rc == 0, f"fppd exited with {rc}\n{fppd.tail()}"
    report = f"{lsan}.{fppd.proc.pid}"
    leaks = ""
    if os.path.exists(report):
        with open(report, errors="replace") as f:
            leaks = f.read()
    ours = [b for b in leaks.split("\n\n") if "FPPGPIOCommand" in b]
    assert not ours, "the GPIO command leaked at shutdown:\n" + "\n\n".join(ours)[:6000]
