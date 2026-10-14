"""Cape detection (fppcapedetect, run by fppinit's detectCape step) with
an unsigned virtual cape EEPROM, in the fppinit sandbox.

An EEPROM image is an uploaded file as often as it is a chip, so everything
in an unsigned one is untrusted: a cape may suggest defaults, but it may not
override what the user chose, switch on telemetry where that needs consent,
retire settings, copy files out of the media directory, or have its archive
write anywhere but its own scratch directory. These are the rules CapeUtils
enforces; each scenario shows one holding.

Runs on a device (fppcapedetect isn't built in a container).
"""

import json
import os

import pytest

import cape_eeprom as ee
from fppinit import fppinit  # noqa: F401 -- the fixture

EEPROM = "config/cape-eeprom.bin"


def settings_of(sb):
    out = {}
    if not sb.media_exists("settings"):
        return out
    for line in sb.media_file("settings").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


def detect(sb, *args):
    r = sb.capedetect("-no-set-permissions", *args)
    out = r.stdout + r.stderr
    assert "AddressSanitizer" not in out and "terminate called" not in out, out[-3000:]
    assert r.returncode == 0, f"fppcapedetect exited {r.returncode}:\n{out[-3000:]}"
    return out


def cape_info(sb):
    assert sb.media_exists("tmp/cape-info.json"), "no cape-info.json was published"
    return json.loads(sb.media_file("tmp/cape-info.json"))


def test_an_unsigned_virtual_cape_is_detected(fppinit):
    """The baseline the rest rely on: an unsigned image in config is found,
    unpacked into media/tmp and reported UNSIGNED, and a default it suggests
    for a setting nobody has set is applied."""
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(defaultSettings={"CapeTestSetting": "on"})))
    detect(fppinit)
    info = cape_info(fppinit)
    assert info["id"] == "TestCape", info
    assert info["capeStatus"] == "UNSIGNED", info
    assert settings_of(fppinit).get("CapeTestSetting") == "on", fppinit.media_file("settings")


def test_a_cape_default_never_overrides_the_user(fppinit):
    """defaultSettings fills in what is unset and leaves alone what the
    user chose.

    Regression: 5d10a7067 (with 55ed9a5d1's rework of the same check)."""
    fppinit.settings(CapeTestChosen="mine")
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(defaultSettings={
        "CapeTestChosen": "cape", "CapeTestUnset": "cape"})))
    out = detect(fppinit)
    s = settings_of(fppinit)
    assert s.get("CapeTestChosen") == "mine", out
    assert s.get("CapeTestUnset") == "cape", out


@pytest.mark.parametrize("jurisdiction,tz,applied", [
    ("EU", None, False),
    ("UK", None, False),
    (None, "Europe/Berlin", False),
    (None, None, False),
    ("US", None, True),
    (None, "America/New_York", True),
], ids=["EU", "UK", "EU by time zone", "unknown", "US", "US by time zone"])
def test_a_cape_cannot_switch_on_telemetry_where_consent_is_needed(fppinit, jurisdiction, tz, applied):
    """A cape's default for a setting that transmits (statsPublish=Enabled)
    is held where the jurisdiction requires prior opt-in -- recorded, or
    inferred from the time zone -- and where the jurisdiction isn't known
    at all; elsewhere it is applied like any other default.

    Regression: 5d10a7067 (the opt-in rule), 0106041d9 (an unknown
    jurisdiction counted as unrestricted)."""
    if jurisdiction:
        fppinit.settings(LegalJurisdiction=jurisdiction)
    if tz:
        fppinit.settings(TimeZone=tz)
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(defaultSettings={"statsPublish": "Enabled"})))
    out = detect(fppinit)
    got = settings_of(fppinit).get("statsPublish")
    if applied:
        assert got == "Enabled", out
    else:
        assert got is None, f"statsPublish set to {got!r}:\n{out}"
        assert "prior opt-in" in out, out


def test_a_cape_cannot_choose_the_signing_host(fppinit):
    """SigningAPIHost decides where the device sends its serial and account
    credentials: no cape sets it, though it is unset and not telemetry.

    Regression: 5ff8454fe."""
    fppinit.settings(LegalJurisdiction="US")
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(defaultSettings={
        "SigningAPIHost": "signing.example.invalid", "CapeTestUnset": "cape"})))
    out = detect(fppinit)
    s = settings_of(fppinit)
    assert "SigningAPIHost" not in s, out
    assert s.get("CapeTestUnset") == "cape", out


def test_an_unsigned_cape_cannot_remove_settings(fppinit):
    """removeSettings deletes a value the user may have chosen, which wants
    a signature; an unsigned image's list is ignored.

    Regression: 55ed9a5d1."""
    fppinit.settings(CapeTestChosen="mine")
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(removeSettings=["CapeTestChosen"])))
    out = detect(fppinit)
    assert settings_of(fppinit).get("CapeTestChosen") == "mine", out
    assert "ignoring removeSettings" in out, out


def test_unsigned_copy_files_stay_inside_the_media_directory(fppinit):
    """copyFiles from an unsigned image may copy a file from FPP's own tree
    into the media directory, and nothing else: not from elsewhere (the
    settings file, with every password on the box), not to a path outside
    the media directory (an apt source runs code as root), not over the
    settings file, and nothing with '..' in it.

    Regression: d528332f8, and 9b8389034 for a relative source, which an
    unsigned image read relative to the working directory."""
    fppinit.settings(CapeTestChosen="mine")
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(copyFiles={
        "/opt/fpp/etc/jurisdictions.json": "config/cape-copied.json",
        "/home/fpp/media/settings": "config/settings-copy",
        "/etc/hostname": "config/hostname-copy",
        "etc/hostname": "config/relative-copy",
        "/opt/fpp/etc/jurisdictions.json/../../../../etc/passwd": "config/passwd-copy",
        "/opt/fpp/www/settings.json": "/etc/apt/sources.list.d/cape.list",
        "/opt/fpp/www/index.php": "settings",
        "/opt/fpp/www/about.php": "config/../../../../etc/cape-escaped",
    })))
    out = detect(fppinit)
    assert fppinit.media_exists("config/cape-copied.json"), \
        f"the one permitted copy didn't happen:\n{out}"
    for rel in ("config/settings-copy", "config/hostname-copy", "config/relative-copy",
                "config/passwd-copy"):
        assert not fppinit.media_exists(rel), f"{rel} was copied:\n{out}"
    assert fppinit.written("/etc/apt/sources.list.d/cape.list") is None, out
    assert fppinit.written("/etc/cape-escaped") is None, out
    assert settings_of(fppinit).get("CapeTestChosen") == "mine", \
        f"the settings file was replaced:\n{out}"


def test_unsigned_cape_loses_what_needs_a_signature(fppinit):
    """An unsigned image's sensor and input definitions are dropped, as is
    its sendStats, while the rest of its files are published.

    (Long-standing; 5d10a7067 removed the branch that switched statistics on
    for an unsigned image.)"""
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(sendStats=True), files={
        "cape-sensors.json": {"sensors": []},
        "cape-inputs.json": {"inputs": []},
        "cape-test.json": {"kept": True},
    }))
    detect(fppinit)
    info = cape_info(fppinit)
    assert "sendStats" not in info, info
    assert fppinit.media_exists("tmp/cape-test.json")
    assert not fppinit.media_exists("tmp/cape-sensors.json")
    assert not fppinit.media_exists("tmp/cape-inputs.json")


def test_a_signature_that_does_not_verify_is_not_trusted(fppinit):
    """An image whose signature fails is less trusted than one with none:
    its default configuration files aren't installed, though the same files
    from an unsigned image are."""
    files = {"defaults/config/cape-default-test.json": {"x": 1}}
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(), files=files,
                                         signature=("dk", b"\x01" * 256)))
    out = detect(fppinit)
    assert "signature is NOT valid" in out, out
    assert not fppinit.media_exists("config/cape-default-test.json"), out

    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(), files=files))
    detect(fppinit)
    assert fppinit.media_exists("config/cape-default-test.json")


def test_archive_symlinks_are_not_followed(fppinit):
    """A symlink in the cape archive is not followed when its files are
    published or its defaults installed: one pointing at /etc would copy
    the host's files into the media directory the web UI serves.

    Regression: ec0bcbcf3."""
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(), files={"cape-test.json": {}}, links={
        "etc-link": "/etc",
        "defaults/config/shadow-link": "/etc/shadow",
        "loop": ".",
    }))
    out = detect(fppinit)
    assert fppinit.media_exists("tmp/cape-test.json"), out
    assert not fppinit.media_exists("tmp/etc-link/passwd"), out
    assert not fppinit.media_exists("config/shadow-link"), out


def _corrupt(name):
    h = ee.header()
    good = ee.record(2, ee.tgz({"cape-info.json": ee.cape_info(),
                                "cape-image.xbm": "#define x_width 8\n"}), path="tmp/cape-info.tgz")
    return {
        "name escapes": h + ee.record(0, "x", path="../../../../etc/cape-escaped") + ee.END,
        "absolute name": h + ee.record(0, "x", path="/etc/cape-escaped") + ee.END,
        # A record type nothing handles is skipped with a seek by its length.
        "negative length": h + ee.raw_record(-100, 60) + ee.END,
        "length past the buffer": h + ee.raw_record(1000000, 0, path="tmp/x") + b"x" * 40000,
        "ends inside a file": h + good + ee.raw_record(5000, 0, path="tmp/cape-image.xbm", data=b"y" * 100),
    }[name]


CORRUPT = ["name escapes", "absolute name", "negative length", "length past the buffer",
           "ends inside a file"]


@pytest.mark.parametrize("name", CORRUPT)
def test_a_corrupt_image_publishes_nothing(fppinit, name):
    """A malformed image is reported corrupt and nothing from it is
    published -- including files unpacked before the damage was reached, a
    truncated cape-image.xbm among them, which took down fppoled -- and
    nothing it names is written outside the extraction directory. No
    overflow, no endless parse.

    Regression: ec0bcbcf3."""
    fppinit.write_bytes(EEPROM, _corrupt(name))
    out = detect(fppinit)
    assert "Corrupt EEPROM" in out, out
    assert not fppinit.media_exists("tmp/cape-info.json"), out
    assert not fppinit.media_exists("tmp/cape-image.xbm"), out
    assert fppinit.written("/etc/cape-escaped") is None, out


def test_a_read_only_probe_keeps_the_cape_info(fppinit):
    """`fppcapedetect -ro` reads the cape without regenerating anything, so
    the cape-info.json the boot run published is still there afterwards.

    Regression: 32dd31529. -ro deleted media/tmp first and, being
    read-only, never wrote it back."""
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info()))
    detect(fppinit)
    before = fppinit.media_file("tmp/cape-info.json")
    detect(fppinit, "-ro")
    assert fppinit.media_exists("tmp/cape-info.json"), "-ro deleted cape-info.json"
    assert fppinit.media_file("tmp/cape-info.json") == before


def on_pi():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith("Raspberry Pi")
    except OSError:
        return False


@pytest.mark.skipif(not on_pi(), reason="the cape overlay line is config.txt's, on a Pi")
def test_a_read_only_probe_leaves_the_boot_config_alone(fppinit):
    """With no cape, the boot run makes sure config.txt loads the cape
    overlay (the default one); a read-only probe -- fppd's outputs, the
    setup wizard -- must not touch config.txt or reboot.

    Regression: 6f858aa07."""
    original = "[all]\ndtparam=audio=on\n"
    with open(os.path.join(fppinit.boot, "config.txt"), "w") as f:
        f.write(original)
    detect(fppinit, "-ro")
    assert fppinit.boot_file("config.txt") == original, fppinit.boot_file("config.txt")
    assert not fppinit.media_exists("tmp/reboot")

    detect(fppinit)
    assert "dtoverlay=fpp-cape-overlay" in fppinit.boot_file("config.txt"), \
        "the control: a full run adds the overlay"


@pytest.mark.skipif(not on_pi(), reason="the string config mapped here is a Pi one")
def test_a_read_only_probe_does_not_install_a_virtual_eeprom(fppinit):
    """A string config left from a cape with no EEPROM chip maps to the
    virtual EEPROM FPP ships for it. The boot run installs that; a
    read-only probe only reports it.

    Regression: 6f858aa07. The probe installed it and switched itself to
    read-write for the rest of the run."""
    fppinit.write("config/co-pixelStrings.json", {"channelOutputs": [{
        "type": "DPIPixels", "subType": "PiHat-DPIPixels", "enabled": 1,
        "startChannel": 1, "channelCount": 0, "outputs": []}]})
    out = detect(fppinit, "-ro")
    assert not fppinit.media_exists(EEPROM), out
    out = detect(fppinit)
    assert fppinit.media_exists(EEPROM), f"the control: a full run installs it\n{out}"
    assert cape_info(fppinit)["id"] == "PiHat"


def test_dry_run_reports_and_writes_nothing(fppinit):
    """`fppcapedetect -dry-run -regime=X` (the setup wizard) says which of
    a cape's defaults the answer X permits, as one JSON line, and changes
    nothing.

    Regression: c051774ee."""
    fppinit.settings(CapeTestChosen="mine")
    fppinit.write_bytes(EEPROM, ee.image(ee.cape_info(defaultSettings={
        "statsPublish": "Enabled", "CapeTestUnset": "cape", "CapeTestChosen": "cape"})))
    before = fppinit.media_file("settings")
    for regime, stats_ok in (("EU", False), ("US", True)):
        r = fppinit.capedetect("-dry-run", f"-regime={regime}")
        assert r.returncode == 0, r.stdout + r.stderr
        line = [l for l in r.stdout.splitlines() if l.strip()][-1]
        res = json.loads(line)
        assert res["jurisdiction"] == regime and res["priorOptIn"] == (not stats_ok), res
        assert res["settings"].get("CapeTestUnset") == "cape", res
        assert "CapeTestChosen" in res["refused"], res
        assert ("statsPublish" in res["settings"]) == stats_ok, res
        assert ("statsPublish" in res["refused"]) == (not stats_ok), res
    assert fppinit.media_file("settings") == before
    assert not fppinit.media_exists("tmp/cape-info.json")
