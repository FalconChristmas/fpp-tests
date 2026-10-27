"""fppd's check, at startup, that the drogon library it loaded is the release
whose headers it was built against."""

import re

import shims
from fppd import FppdDied


def built_version():
    with open("/usr/include/drogon/version.h") as f:
        return re.search(r'#define DROGON_VERSION "([^"]+)"', f.read()).group(1)


def start_reporting(fppd, version):
    fppd.start(timeout=30, preload=[shims.build("drogonversion.cpp", libs=())],
               extra_env={"DROGON_FAKE_VERSION": version})


def test_a_drogon_library_from_another_release_stops_fppd_with_a_reason(fppd):
    """With libdrogon reporting a release other than the headers fppd was
    built against (drogonversion.so stands in for the other library), fppd
    exits at startup and says which two versions disagree.

    Regression: c6d1632dc. fppd went on to register its routes through
    templates instantiated from its own headers, calling into the other
    release's library by vtable slot, and segfaulted on every start: drogon
    keeps one SONAME across releases, so the dynamic linker let it load.
    The stand-in only changes the version reported, so here the parent
    simply starts."""
    built = built_version()
    major, minor = built.split(".")[:2]
    other = f"{major}.{int(minor) + 1}.0"
    try:
        start_reporting(fppd, other)
    except FppdDied:
        pass
    else:
        raise AssertionError(f"fppd started with libdrogon reporting {other}, built against {built}")
    fppd.exit_expected = True
    assert fppd.proc.returncode == 1, fppd.tail()
    assert f"built against drogon {built} headers but loaded libdrogon {other}" in fppd.log(), fppd.tail()


def test_a_drogon_library_from_another_patch_release_is_noted(fppd):
    """With libdrogon reporting another patch release of the same major.minor
    (a distro update within a release), fppd starts and notes both versions.

    Regression: c6d1632dc (the half that must not refuse)."""
    built = built_version()
    major, minor = built.split(".")[:2]
    other = f"{major}.{minor}.99"
    start_reporting(fppd, other)
    assert fppd.get("/fppd/status", timeout=5)["status_name"]
    assert f"built against drogon {built} headers and loaded libdrogon {other}" in fppd.log()
