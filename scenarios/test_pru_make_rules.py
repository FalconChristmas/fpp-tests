"""The AM62x PRU firmware rules in src/makefiles/libfpp-co-BBShift*.mk and
the FalconV5 support library's rule, read from make's dry run (clpru is
not installed here, so nothing is built): what each rule would write, and
where, and what it builds first.
"""

import glob
import os
import re
import subprocess

TREE = os.environ.get("FPP_TREE", "")
MAKEFILES = ("libfpp-co-BBShiftPanel.mk", "libfpp-co-BBShiftString.mk")


def dry_runs(tmp_path):
    """{target: recipe lines of `make -n -B target`} for every PRU firmware
    image the two makefiles define, as an AM62x board reads them."""
    mk = tmp_path / "Makefile"
    includes = "".join(f"include $(SRCDIR)/makefiles/{m}\n" for m in MAKEFILES)
    mk.write_text(f"SRCDIR := {TREE}/src\n"
                  "include $(SRCDIR)/makefiles/common/setup.mk\n" + includes)
    targets = []
    for m in MAKEFILES:
        text = open(os.path.join(TREE, "src", "makefiles", m)).read()
        targets += re.findall(r"^(non-gpl/\S+\.out):", text, re.M)
    out = {}
    for t in sorted(set(targets)):
        r = subprocess.run(["make", "-n", "-B", "-f", str(mk), "ARCH=BeagleBone 64", "ARMV=aarch64",
                            "ISBEAGLEBONE=1", t],
                           capture_output=True, text=True, timeout=60, cwd=os.path.join(TREE, "src"))
        assert r.returncode == 0, f"{t}: {r.stdout[-500:]}{r.stderr[-1500:]}"
        out[t] = [l for l in r.stdout.splitlines() if l.startswith(("/usr/bin/cpp", "clpru"))]
    return out


def test_each_pru_image_rule_writes_its_own_target(tmp_path):
    """Every AM62x PRU firmware rule links the file it is the rule for, so
    make finds it up to date after building it.

    Regression: d12124f86. The BBShiftPanel.out and _single.out rules were
    swapped (each wrote the other's file), so one of them was rebuilt on
    every make.
    """
    runs = dry_runs(tmp_path)
    assert len(runs) >= 15, sorted(runs)  # the control: the rules were found
    for target, lines in runs.items():
        link = [l for l in lines if " -z " in l]
        assert link, f"{target}: no link step in {lines}"
        assert f'-o "{target}"' in link[0], f"{target} is built by a rule that writes elsewhere: {link[0]}"


def test_pru_image_rules_do_not_share_temporary_files(tmp_path):
    """No two AM62x PRU firmware rules use the same intermediate file under
    /tmp, so a parallel make can't have one rule clobber another's.

    Regression: 86190cbd2. The intermediates were named after the source
    (BBShiftString.asm/.obj for every variant), so make -j built garbage.
    """
    runs = dry_runs(tmp_path)
    owners = {}
    for target, lines in runs.items():
        for l in lines:
            for tmp in re.findall(r'"(/tmp/[^"]+)"', l):
                owners.setdefault(tmp, set()).add(target)
    assert len(owners) >= 20, owners  # the control: the temporaries were found
    shared = {t: sorted(o) for t, o in owners.items() if len(o) > 1}
    assert not shared, f"temporary files used by more than one rule: {shared}"


def test_falconv5_support_waits_for_the_library_it_links(tmp_path):
    """libfpp-FalconV5Support is linked only after libFalconV5 has been
    unpacked, whatever order the targets are given in.

    Regression: ab0d879d2. The support library linked -lFalconV5 but did not
    depend on it, so building it alone (the Upgrade button's make) failed
    for want of libFalconV5.so.
    """
    mk = tmp_path / "Makefile"
    mk.write_text(f"SRCDIR := {TREE}/src\nSHLIB_EXT := so\n"
                  "include $(SRCDIR)/makefiles/common/setup.mk\n"
                  "include $(SRCDIR)/makefiles/libfpp-co-FalconV5Support.mk\n"
                  "libfpp.$(SHLIB_EXT): ; @echo built $@\n"
                  "non-gpl/FalconV5Support/FalconV5Support.o: ; @echo built $@\n")
    r = subprocess.run(["make", "-n", "-f", str(mk), "ARCH=BeagleBone 64", "ARMV=aarch64",
                        "ISBEAGLEBONE=1", "libfpp-FalconV5Support.so"],
                       capture_output=True, text=True, timeout=60, cwd=os.path.join(TREE, "src"))
    assert r.returncode == 0, r.stdout[-500:] + r.stderr[-1500:]
    lines = r.stdout.splitlines()
    unpack = [i for i, l in enumerate(lines) if l.startswith("zstd -fd") and "libFalconV5.so" in l]
    link = [i for i, l in enumerate(lines) if "-shared" in l and "libfpp-FalconV5Support.so" in l]
    assert unpack and link, r.stdout[-2000:]
    assert unpack[0] < link[0], r.stdout[-2000:]
