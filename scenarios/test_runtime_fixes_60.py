"""Fixes from the 6.0 release that are reachable from scripts/common."""

import os
import subprocess


def shell(tree, cfg, script):
    env = {"PATH": os.environ["PATH"], "HOME": str(cfg.parent), "CFGFILE": str(cfg),
           "FPPDIR": tree, "MEDIADIR": str(cfg.parent)}
    return subprocess.run(["bash", "-c", f". {tree}/scripts/common; {script}"], env=env,
                          capture_output=True, timeout=30)


def test_settings_file_with_a_null_byte_is_read_and_cleaned(tmp_path):
    """getSetting reads a value from a settings file that has a NUL in it,
    and setSetting removes the NULs.

    Regression: 63b08d695. grep took the file for binary and answered "Binary
    file matches" instead of the line, so every script that read the setting
    got that text; nothing ever removed the NUL."""
    tree = os.environ["FPP_TREE"]
    cfg = tmp_path / "settings"
    cfg.write_bytes(b'A = "1"\nB = "x\x00y"\n')
    r = shell(tree, cfg, "getSetting A")
    assert r.stdout.decode().strip() == "1", r.stdout + r.stderr
    r = shell(tree, cfg, "setSetting C 3")
    assert r.returncode == 0, r.stderr
    assert b"\x00" not in cfg.read_bytes()
    assert b'C = "3"' in cfg.read_bytes()


def test_set_setting_waits_for_the_settings_file_lock(tmp_path):
    """setSetting from a script waits while something else holds the settings
    file locked, and writes once it is released.

    Regression: 5e984a3ad (flock when setting from bash scripts), made
    patient by a later change that waits instead of failing."""
    import fcntl
    import time
    if not os.path.exists("/usr/bin/flock"):
        import pytest
        pytest.skip("flock is not installed")
    tree = os.environ["FPP_TREE"]
    cfg = tmp_path / "settings"
    cfg.write_text('A = "1"\n')
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "CFGFILE": str(cfg),
           "FPPDIR": tree, "MEDIADIR": str(tmp_path)}
    held = open(cfg)
    fcntl.flock(held, fcntl.LOCK_EX)
    proc = subprocess.Popen(["bash", "-c", f". {tree}/scripts/common; setSetting B 2"], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    assert proc.poll() is None, "setSetting did not wait for the lock"
    assert "B = " not in cfg.read_text(), "setSetting wrote while the file was locked"
    fcntl.flock(held, fcntl.LOCK_UN)
    held.close()
    assert proc.wait(timeout=10) == 0
    assert 'B = "2"' in cfg.read_text()
