"""Header dependency tracking in the makefiles, read from make itself: the
compile lines it would run, what it knows an object depends on once a .d file
exists, and what `make cleanfpp` removes.

Like test_pch_makefile.py these run make -n / -p in a copy of the tree's src/
(its objects left out), so nothing is compiled.
"""

import re

from test_pch_makefile import compile_lines, make, src  # noqa: F401  (src is a fixture)


def test_every_compile_line_writes_header_dependencies(src):
    """Each object is compiled with -MMD -MP, so a .d file listing the headers
    it included is written next to it.

    Regression: 655deb23c. The core's pattern rules listed only a .cpp's own
    same-basename header, so editing any other header left the objects that
    include it out of date, and a build linked stale objects into libfpp.so
    while reporting success.
    """
    lines = {}
    for target in ("fppd", "fppcapedetect", "fsequtils"):
        lines.update(compile_lines(src, target))
    assert len(lines) > 50, sorted(lines)
    # fppd.o and tinyexpr.o have rules of their own, not the shared
    # pattern rules.
    for name in ("fppd.o", "tinyexpr.o", "Events.o"):
        assert name in lines, (name, sorted(lines)[:20])
    missing = sorted(n for n, toks in lines.items()
                     if n.endswith(".o") and not {"-MMD", "-MP"} <= set(toks))
    assert missing == []


def test_a_dependency_file_makes_the_object_depend_on_its_headers(src):
    """With Events.d next to it naming another header, make's database lists
    that header as a prerequisite of Events.o; without the file it doesn't.

    Regression: 655deb23c. Writing the .d files is only half of it; the
    Makefile has to read them back (-include of the object list's .d names),
    or a changed header never rebuilds anything.
    """
    def prereqs():
        r = make(src, "-pnq", "Events.o")
        for line in r.stdout.splitlines():
            if line.startswith("Events.o:"):
                return line.split(":", 1)[1].split()
        raise AssertionError("make has no Events.o rule:\n" + r.stdout[-1500:] + r.stderr[-1500:])

    assert "Settings.h" not in prereqs(), "the control: Settings.h is not a prerequisite without the file"
    (src / "Events.d").write_text("Events.o: Events.cpp Settings.h\n")
    assert "Settings.h" in prereqs()


def test_clean_removes_the_dependency_files(src):
    """`make cleanfpp` and `make clean` delete the .d files with the objects.

    Regression: 655deb23c. Left behind, a .d file names headers that may have
    since moved, and make then stops on a missing prerequisite it has no rule
    for.
    """
    for target in ("cleanfpp", "clean"):
        r = make(src, "-n", target)
        assert r.returncode == 0, r.stdout[-1500:] + r.stderr[-1500:]
        rm = " ".join(l for l in r.stdout.splitlines() if l.startswith("rm -f"))
        assert re.search(r"\bEvents\.d\b", rm), (target, rm[:500])
        assert re.search(r"\bnon-gpl/BBShiftPanel/\S+\.d\b", rm) or re.search(r"\bchanneloutput/processors/\S+\.d\b", rm), (target, rm[:500])
