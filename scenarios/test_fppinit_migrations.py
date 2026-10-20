"""Config migrations fppinit makes as the box starts, in the fppinit sandbox
(fppinit.py): bootPre's rewrites of settings and stored commands that an
older FPP left behind, and the post-reflash replay of the user's package
list.
"""

import json
import os

from fppinit import fppinit  # noqa: F401 -- the fixture


def assert_clean(r):
    out = r.stdout + r.stderr
    assert "terminate called" not in out and "AddressSanitizer" not in out, out[-3000:]
    assert r.returncode == 0, f"fppinit exited {r.returncode}:\n{out[-3000:]}"


def media_settings(sb):
    out = {}
    for line in sb.media_file("settings").splitlines():
        k, sep, v = line.partition("=")
        if sep:
            out[k.strip()] = v.strip().strip('"')
    return out


def remote(command, host, *rest):
    return {"type": "command", "command": command, "args": [host, *rest]}


def test_boot_converts_removed_remote_commands_to_multisync(fppinit):
    """bootPre rewrites the "Remote ..." commands FPP 10 removed -- in
    playlists, the schedule, command presets and GPIO inputs -- into the
    plain command sent to that host over MultiSync. One with an empty or
    %variable% host is left for the user, and a file that names no Remote
    command is not rewritten.

    Feature: f775cd8b3. Before it, every stored use of a Remote command
    from an older install silently did nothing.
    """
    fppinit.write("playlists/show.json", {"name": "show", "mainPlaylist": [
        remote("Remote Playlist Start", "10.0.0.5", "Main", "true", "false"),
        remote("Remote Run Script", "", "a.sh"),
        remote("Remote Run Script", "%HOST%", "b.sh"),
    ]})
    fppinit.write("config/commandPresets.json", {"commands": [
        {"name": "p1", **remote("Remote Trigger Command Preset", "10.0.0.6", "other")}]})
    fppinit.write("config/schedule.json", [
        {"enabled": 1, **remote("Remote Effect Start", "10.0.0.7", "eff", "true", "false")}])
    fppinit.write("config/gpio.json", [{"pin": "P9-12", "enabled": True,
                                        "rising": remote("Remote FSEQ Effect Start", "10.0.0.8", "seq")}])
    untouched = {"name": "plain", "mainPlaylist": [
        {"type": "command", "command": "Start Playlist", "args": ["Main"]}]}
    fppinit.write("playlists/plain.json", untouched)
    plain = os.path.join(fppinit.media, "playlists", "plain.json")
    os.utime(plain, (1000000000, 1000000000))

    r = fppinit.run("bootPre")
    assert_clean(r)

    entries = json.loads(fppinit.media_file("playlists/show.json"))["mainPlaylist"]
    assert entries[0]["command"] == "Start Playlist", entries[0]
    assert entries[0]["args"] == ["Main", "true", "false"], entries[0]
    assert entries[0]["multisyncCommand"] is True and entries[0]["multisyncHosts"] == "10.0.0.5", entries[0]
    for e in entries[1:]:
        assert e["command"] == "Remote Run Script" and "multisyncHosts" not in e, \
            f"an empty or %variable% host was converted: {e}"

    preset = json.loads(fppinit.media_file("config/commandPresets.json"))["commands"][0]
    assert (preset["command"], preset["args"], preset["multisyncHosts"]) == \
        ("Trigger Command Preset", ["other"], "10.0.0.6"), preset
    sched = json.loads(fppinit.media_file("config/schedule.json"))[0]
    assert (sched["command"], sched["args"], sched["multisyncHosts"]) == \
        ("Effect Start", ["eff", "true", "false"], "10.0.0.7"), sched
    rising = json.loads(fppinit.media_file("config/gpio.json"))[0]["rising"]
    assert (rising["command"], rising["args"], rising["multisyncHosts"]) == \
        ("FSEQ Effect Start", ["seq"], "10.0.0.8"), rising

    assert os.stat(plain).st_mtime == 1000000000, "a playlist with no Remote command was rewritten"
    assert json.loads(fppinit.media_file("playlists/plain.json")) == untouched


def test_boot_writes_legacy_master_mode_back_as_player(fppinit):
    """A settings file still holding fppMode=master (the mode FPP 5 folded
    into Player) is rewritten by bootPre as player with MultiSync on --
    the mapping fppd and the UI apply when they read it -- and a remote's
    mode is left alone.

    Feature: f4af6b2d0. Before it the loaders mapped "master" in memory
    only, so the file -- and every backup made from it -- kept it forever.
    """
    fppinit.settings(fppMode="master")
    assert_clean(fppinit.run("bootPre"))
    s = media_settings(fppinit)
    assert s.get("fppMode") == "player", fppinit.media_file("settings")
    assert s.get("MultiSyncEnabled") == "1", fppinit.media_file("settings")
    assert fppinit.media_file("settings").count("fppMode") == 1, fppinit.media_file("settings")

    fppinit.write("settings", 'fppMode = "remote"\n')
    assert_clean(fppinit.run("bootPre"))
    s = media_settings(fppinit)
    assert s.get("fppMode") == "remote" and "MultiSyncEnabled" not in s, fppinit.media_file("settings")


# apt-cache knows every name it is asked about, so a name skipped below was
# skipped by fppinit's own checks.
APT_CACHE = """#!/bin/sh
for a in "$@"; do last=$a; done
echo "$last"
"""


def replay(sb, packages):
    """The first postNetwork after an FPPOS reflash, with this
    config/userpackages.json (a str is written as is). Returns the run
    and the apt-get installs it made."""
    sb.write("config/userpackages.json", packages)
    sb.root_file("/fppos_upgraded", "")
    sb.root_file("/usr/bin/apt-cache", APT_CACHE)
    r = sb._run(["/opt/fpp/src/fppinit", "postNetwork"], timeout=300, media_home=True)
    installs = [c for c in sb.calls() if c.startswith("apt-get") and " install " in c]
    return r, installs


def test_package_replay_after_reflash_installs_only_what_the_user_asked_for(fppinit):
    """After an FPPOS reflash fppinit reinstalls the user's packages from
    config/userpackages.json: each top-level package once, not the
    dependencies recorded with "via" (the parent's install pulls those in
    under whatever the new OS calls them), and never a name that is not a
    package name -- one starting with "-" would be an apt-get option.

    Regression: 4f62c876f. Every entry was replayed as recorded: the "via"
    dependencies by their old versioned names, an option-shaped name into
    root apt-get's argv, and a duplicate twice.
    """
    r, installs = replay(fppinit, [
        {"package": "libfpptest1", "via": ["fpptest-tool"]},
        {"package": "fpptest-tool", "requestedBy": ["user"]},
        "-oAPT::Get::fpp-tests=1",
        "Bad Name",
        "fpptest-tool",
    ])
    assert_clean(r)
    targets = [c.split()[-1] for c in installs]
    assert targets == ["fpptest-tool"], f"apt-get installs: {installs}\n{(r.stdout + r.stderr)[-2000:]}"
    assert not [c for c in fppinit.calls() if "fpp-tests=1" in c or "Bad" in c], fppinit.calls()


def test_a_corrupt_package_list_does_not_take_down_boot(fppinit):
    """A package list nested deeper than the JSON parser's limit is treated
    as nothing to install: fppinit carries on and exits 0. (fppinit has no
    one to restart it.)

    Regression: 4f62c876f. jsoncpp's parser throws past its stack limit,
    and nothing caught it: fppinit terminated mid-boot.
    """
    r, installs = replay(fppinit, "[" * 1001)
    assert_clean(r)
    assert not installs, installs
    assert fppinit.written("/fppos_upgraded") is None, "the reflash marker was kept for a retry"


def test_an_oversized_package_list_is_refused(fppinit):
    """A package list over 4 MB is refused unread: parsing a runaway file
    could exhaust a small board's memory at boot.

    Regression: 4f62c876f. The whole file was parsed, whatever its size.
    """
    r, installs = replay(fppinit, '["fpptest-tool"' + " " * (5 * 1024 * 1024) + "]")
    assert_clean(r)
    assert not installs, installs
    assert "refusing to process it" in r.stdout + fppinit.media_file("logs/fppd.log"), \
        (r.stdout + r.stderr)[-2000:]
