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
