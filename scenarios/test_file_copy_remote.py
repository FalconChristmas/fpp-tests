"""File Copy to and from another player (copy_settings_to_storage.sh,
TOREMOTE / FROMREMOTE): the receiving end is the other player's rsync
daemon, run here from the tree's own etc/rsyncd.conf (its [media] module,
as FPP_Install.sh installs it) on 127.0.0.1 in a network namespace of the
scenario's own.

The script copies from /home/fpp/media, so it runs in a private mount
namespace with the scenario's "local" media directory bound there; the
"remote" player's media directory is another of the scenario's. Needs
root, rsync and an fpp user: run with run-local.sh on a device (the
scenario image has no rsync). web/tests/file-copy-finish-and-eeprom.spec.ts
checks the same copies through copystorage.php with a stand-in rsync.

The tests at the end, on what each item carries, run both ways: to and
from the other player, and to and from this player's own backups/ folder
(TOLOCAL / FROMLOCAL), which takes the plain-path side of the same rsyncs.
"""

import os
import pwd
import shutil
import subprocess
import tempfile

import pytest
from pathlib import Path

RUN = r"""
set -e
TREE=$1; LOCAL=$2; REMOTEHOME=$3; DIRECTION=$4; shift 4
ip link set lo up
sed -e "s#FPPHOME#$REMOTEHOME#g" -e "s#FPPUSER#fpp#g" "$TREE/etc/rsyncd.conf" > "$REMOTEHOME/rsyncd.conf"
rsync --daemon --no-detach --address=127.0.0.1 --config="$REMOTEHOME/rsyncd.conf" &
DAEMON=$!
n=0; until (echo > /dev/tcp/127.0.0.1/873) 2>/dev/null; do n=$((n+1)); [ $n -lt 50 ] || exit 3; sleep 0.1; done
mkdir -p /home/fpp/media
mount --bind "$LOCAL" /home/fpp/media
if [ -n "$STORE" ]; then
    # The other player's USB device, where its mount API puts it (on a
    # private /mnt), and that API answering that it mounted it.
    mount -t tmpfs tmpfs /mnt
    mkdir /mnt/remote_filecopy
    mount --bind "$STORE" /mnt/remote_filecopy
    python3 -c 'import http.server as h
class R(h.BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(b"{\"Status\": \"OK\", \"Message\": \"mounted\"}")
h.HTTPServer(("127.0.0.1", 80), R).serve_forever()' > /dev/null 2>&1 &
    SERVER=$!
    n=0; until (echo > /dev/tcp/127.0.0.1/80) 2>/dev/null; do n=$((n+1)); [ $n -lt 50 ] || exit 4; sleep 0.1; done
fi
cd /tmp
set +e
bash "$TREE/scripts/copy_settings_to_storage.sh" 127.0.0.1 fpp-test "$DIRECTION" "${RSTORAGE:-none}" no no "$@"
echo "SCRIPT-RC=$?"
kill $DAEMON ${SERVER:-}
"""

EEPROM = b"FPP02fpp-tests remote eeprom" + bytes(100)


@pytest.fixture
def players(tmp_path):
    """(local media, remote home): the remote's media is <home>/media."""
    tree = os.environ.get("FPP_TREE", "")
    if os.geteuid() != 0 or not os.path.exists(os.path.join(tree, "etc", "rsyncd.conf")):
        pytest.skip("needs root and an fpp tree")
    for tool in ("rsync", "unshare", "ip"):
        if not shutil.which(tool):
            pytest.skip(f"no {tool}")
    try:
        fpp = pwd.getpwnam("fpp")
    except KeyError:
        pytest.skip("no fpp user")
    local = tmp_path / "local"
    # Not under pytest's tmp_path, whose parents are root's alone (0700):
    # the daemon reaches the module as fpp.
    remote_dir = tempfile.mkdtemp(prefix="fpp-tests-remote-", dir="/tmp")
    os.chmod(remote_dir, 0o755)
    remote = Path(remote_dir) / "home"
    for d in (local / "config", local / "tmp", remote / "media" / "backups", remote / "media" / "logs"):
        d.mkdir(parents=True)
    (local / "config" / "cape-eeprom.bin").write_bytes(EEPROM)
    (local / "settings").write_text('HostName = "fpp-tests-local"\n')
    # The daemon's [media] module runs as fpp; so must what it writes to be.
    for root, dirs, files in os.walk(remote):
        for n in dirs + files:
            os.chown(os.path.join(root, n), fpp.pw_uid, fpp.pw_gid)
    os.chown(remote, fpp.pw_uid, fpp.pw_gid)
    try:
        yield local, remote
    finally:
        shutil.rmtree(remote_dir, ignore_errors=True)


def copy(players, direction, *flags, env=None):
    local, remote = players
    r = subprocess.run(["unshare", "--mount", "--net", "--propagation", "private", "bash", "-c", RUN,
                        "bash", os.environ["FPP_TREE"], str(local), str(remote), direction, *flags],
                       capture_output=True, text=True, timeout=180, env=dict(os.environ, **(env or {})))
    out = r.stdout + r.stderr
    assert "SCRIPT-RC=" in out, out[-3000:]
    return out


def remote_eeprom(players):
    return players[1] / "media" / "backups" / "fpp-test" / "config" / "cape-eeprom.bin"


def test_a_backup_to_remote_puts_the_cape_eeprom_in_the_backups_config_folder(players):
    """A Backup to Remote of Configuration and EEPROM -- the order the
    Backup page sends them in -- leaves the cape EEPROM, byte for byte, in
    the other player's backups/<folder>/config/, and says it is complete.

    Regression: cf08d1cd9 (#2219). The EEPROM was copied with cp, onto
    "127.0.0.1::media/backups/<folder>/config/", which is no path here:
    cp failed and the other player never got it.
    """
    out = copy(players, "TOREMOTE", "Configuration", "EEPROM")
    assert "SCRIPT-RC=0" in out and "BACKUP COMPLETE" in out, out[-3000:]
    eeprom = remote_eeprom(players)
    assert eeprom.is_file(), f"no {eeprom}:\n{out[-3000:]}"
    assert eeprom.read_bytes() == EEPROM


def test_a_backup_to_the_other_players_usb_device_lands_on_it(players):
    """A Backup to Remote naming one of the other player's storage devices
    has that player mount it at /mnt/remote_filecopy and rsyncs to its
    [remote_filecopy] module: the backup is on the device, not in the
    other player's media/backups.

    Regression: 3011c43ef ("Updated \\etc\\rsync.conf template"). The
    template had no [remote_filecopy] module, so a player installed from it
    refused the copy (unknown module) and nothing reached the device.
    """
    store = Path(tempfile.mkdtemp(prefix="fpp-tests-usb-", dir="/tmp"))
    try:
        fpp = pwd.getpwnam("fpp")
        os.chmod(store, 0o755)
        os.chown(store, fpp.pw_uid, fpp.pw_gid)
        out = copy(players, "TOREMOTE", "Configuration", "EEPROM",
                   env={"STORE": str(store), "RSTORAGE": "sda1"})
        eeprom = store / "fpp-test" / "config" / "cape-eeprom.bin"
        assert eeprom.is_file(), f"no {eeprom}:\n{out[-3000:]}"
        assert eeprom.read_bytes() == EEPROM
        assert "SCRIPT-RC=0" in out, out[-3000:]
        assert not remote_eeprom(players).exists(), "the backup went to media/backups, not the device"
    finally:
        shutil.rmtree(store, ignore_errors=True)


def test_a_backup_to_remote_of_the_eeprom_alone_puts_it_in_the_config_folder(players):
    """A Backup to Remote of the EEPROM alone leaves it in the other
    player's backups/<folder>/config/.

    Regression: f2d8517ff. The script made the config folder with a local
    mkdir of "<host>::media/backups/<folder>/config", which made nothing on
    the other player, and its rsync to ".../config" (no trailing slash)
    saved the EEPROM as a file named config."""
    out = copy(players, "TOREMOTE", "EEPROM")
    eeprom = remote_eeprom(players)
    folder = eeprom.parent.parent
    there = sorted((p.name + ("/" if p.is_dir() else "")) for p in folder.iterdir()) if folder.is_dir() else []
    assert eeprom.is_file(), f"no {eeprom}; the backup folder holds {there}:\n{out[-3000:]}"
    assert eeprom.read_bytes() == EEPROM


def test_a_restore_from_remote_brings_the_cape_eeprom_back(players):
    """The other half of cf08d1cd9 (#2219): a Restore From Remote of the
    EEPROM fetches it from the other player's backup folder.

    Regression: f2d8517ff. The script checked [ -f "$SOURCE/config/
    cape-eeprom.bin" ] with $SOURCE a <host>::media path, so it always said
    the EEPROM did not exist, never ran the rsync, and reported success."""
    out = copy(players, "TOREMOTE", "Configuration", "EEPROM")
    assert remote_eeprom(players).is_file(), out[-3000:]
    local = players[0] / "config" / "cape-eeprom.bin"
    local.unlink()
    out = copy(players, "FROMREMOTE", "EEPROM")
    assert local.is_file(), f"the EEPROM was not restored:\n{out[-3000:]}"
    assert local.read_bytes() == EEPROM


def test_a_restore_from_remote_of_a_backup_without_an_eeprom_is_not_a_failure(players):
    """A Restore From Remote of the EEPROM from a backup that has none (a
    player with no cape EEPROM was backed up) copies nothing and still
    reports the backup complete, as the local directions do with "nothing
    to copy" -- and leaves no EEPROM behind.

    Since f2d8517ff the remote case is one rsync with --ignore-missing-args
    (rsync 3.1+ on both players); without it a missing source is rsync's
    exit 23 and the restore would report BACKUP FAILED.
    """
    local = players[0] / "config" / "cape-eeprom.bin"
    local.unlink()
    out = copy(players, "TOREMOTE", "Configuration")
    assert "SCRIPT-RC=0" in out, out[-3000:]
    assert not remote_eeprom(players).exists()
    out = copy(players, "FROMREMOTE", "EEPROM")
    assert "SCRIPT-RC=0" in out and "BACKUP COMPLETE" in out, out[-3000:]
    assert "BACKUP FAILED" not in out, out[-3000:]
    assert not local.exists(), out[-3000:]


# --- What each item carries (#3157) -----------------------------------------
#
# Each is (backup direction, restore direction, the backup folder's path
# relative to the local media directory or the remote's home).
ROUND_TRIPS = {
    "remote": ("TOREMOTE", "FROMREMOTE", "remote", "media/backups/fpp-test"),
    "local": ("TOLOCAL", "FROMLOCAL", "local", "backups/fpp-test"),
}


@pytest.fixture(params=sorted(ROUND_TRIPS))
def trip(request, players):
    """(backup direction, restore direction, backup folder, local media)."""
    to, frm, side, rel = ROUND_TRIPS[request.param]
    local, remote = players
    return to, frm, (remote if side == "remote" else local) / rel, local


# The run's stage, as copystorage.php names it (the media directory is bound
# at /home/fpp/media inside the run).
STAGE_FLAG = "Stage:/home/fpp/media/tmp/filecopy-stage-"


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_a_plugins_round_trip_brings_back_each_plugins_settings(players, trip):
    """A backup of Configuration and Plugins, restored with Plugins, brings
    back each plugin's settings in config/plugin.<name>[.json] -- a file or
    a folder -- with the plugin itself.  pluginPrivacyAccepted.json (and
    pluginHistory.jsonl) stay this player's own.

    Regression: #3157. Configuration's unanchored --exclude=plugin* drops
    config/plugin.* too, and Plugins only took the top-level plugins/ and
    plugindata/, so no item copied a plugin's settings: a restored plugin
    came back unconfigured. Fixed by 941f54ad1.
    """
    to, frm, folder, local = trip
    write(local / "plugins" / "fpp-test-plugin" / "plugin.json", "{}")
    write(local / "config" / "plugin.fpp-test-plugin.json", '{"color": "red"}')
    write(local / "config" / "plugin.fpp-test-dir" / "state", "kept")
    write(local / "config" / "pluginPrivacyAccepted.json", '{"fpp-test-plugin": true}')
    out = copy(players, to, "Configuration", "Plugins")
    assert "SCRIPT-RC=0" in out, out[-3000:]
    assert (folder / "config" / "plugin.fpp-test-plugin.json").is_file(), f"not in the backup:\n{out[-3000:]}"

    for p in ("plugins", "config/plugin.fpp-test-plugin.json", "config/plugin.fpp-test-dir",
              "config/pluginPrivacyAccepted.json"):
        shutil.rmtree(local / p) if (local / p).is_dir() else (local / p).unlink()
    out = copy(players, frm, "Plugins")
    assert "SCRIPT-RC=0" in out and "BACKUP COMPLETE" in out, out[-3000:]
    assert (local / "plugins" / "fpp-test-plugin" / "plugin.json").is_file(), out[-3000:]
    assert (local / "config" / "plugin.fpp-test-plugin.json").read_text() == '{"color": "red"}', out[-3000:]
    assert (local / "config" / "plugin.fpp-test-dir" / "state").read_text() == "kept", out[-3000:]
    assert not (local / "config" / "pluginPrivacyAccepted.json").exists(), out[-3000:]


def test_a_configuration_backup_leaves_out_crash_reports_uploads_and_tmp(players, trip):
    """A Configuration backup holds no crash reports, upload leftovers or
    scratch files (crashes/, upload/, tmp/ at the top of the media
    directory), and still takes a config/ subfolder that happens to be
    named tmp.

    Regression: #3157 follow-up. Configuration copies all it does not
    exclude, and these were not excluded, so a restore put the old
    player's crash reports on the new one. Fixed by 941f54ad1.
    """
    to, _, folder, local = trip
    write(local / "crashes" / "fpp-crash.zip", "crash")
    write(local / "upload" / "partial.bin", "upload")
    write(local / "tmp" / "scratch", "scratch")
    write(local / "config" / "tmp" / "keep", "config")
    out = copy(players, to, "Configuration")
    assert "SCRIPT-RC=0" in out, out[-3000:]
    assert (folder / "settings").is_file(), out[-3000:]
    assert (folder / "config" / "tmp" / "keep").is_file(), out[-3000:]
    for p in ("crashes/fpp-crash.zip", "upload/partial.bin", "tmp/scratch"):
        assert not (folder / p).exists(), f"{p} is in the backup"


def test_a_settings_area_restore_stages_what_the_areas_read_and_nothing_else(players, trip):
    """A restore of Configuration by settings area (copystorage.php's
    configArea) copies the backup's settings, config/, playlists/ and
    scripts/ into the run's own tmp/filecopy-stage-<id>/ -- what backup.php
    reads the areas from -- and puts nothing in place: the media
    directory's own files, and another run's stage, are untouched.  The backup's JSON backups (config/backups/), its cape EEPROM
    (the EEPROM item restores that) and media stay out, and the script
    leaves the end of the run to copystorage.php.

    Regression: #3157. File Copy could only restore all of Configuration;
    the areas the JSON settings restore offers were not available.  (The
    first version shared one tmp/filecopy-stage/ between runs, so two at
    once removed each other's.)  Fixed by 701370118.
    """
    to, frm, folder, local = trip
    write(local / "settings", 'HostName = "backed-up"\n')
    write(local / "config" / "schedule.json", '{"s": "backed up"}')
    write(local / "config" / "backups" / "settings-backup.json", "{}")
    write(local / "playlists" / "show.json", "{}")
    write(local / "scripts" / "lights.sh", "#!/bin/sh\n")
    write(local / "music" / "song.mp3", "mp3")
    out = copy(players, to, "Configuration", "EEPROM", "Playlists", "Scripts", "Music")
    assert "SCRIPT-RC=0" in out, out[-3000:]
    assert (folder / "config" / "cape-eeprom.bin").is_file(), out[-3000:]
    (folder / "config" / "backups").mkdir(parents=True, exist_ok=True)
    write(folder / "config" / "backups" / "settings-backup.json", "{}")

    write(local / "settings", 'HostName = "this-player"\n')
    write(local / "config" / "schedule.json", '{"s": "this player"}')
    # A stage left by another run: this run's own must not touch it.
    write(local / "tmp" / "filecopy-stage-other" / "settings", "another run's")
    out = copy(players, frm, STAGE_FLAG + "run1")
    assert "SCRIPT-RC=0" in out, out[-3000:]
    assert "restoring the chosen settings areas next" in out, out[-3000:]
    assert "BACKUP COMPLETE" not in out and "BACKUP FAILED" not in out, out[-3000:]
    assert (local / "tmp" / "filecopy-stage-other" / "settings").read_text() == "another run's"
    stage = local / "tmp" / "filecopy-stage-run1"
    staged = sorted(str(p.relative_to(stage)) for p in stage.rglob("*") if p.is_file())
    assert staged == ["config/schedule.json", "playlists/show.json", "scripts/lights.sh", "settings"], staged
    assert (stage / "settings").read_text() == 'HostName = "backed-up"\n'
    assert (local / "settings").read_text() == 'HostName = "this-player"\n'
    assert (local / "config" / "schedule.json").read_text() == '{"s": "this player"}'


def test_stage_is_refused_for_a_backup(players):
    """Stage only means something for a restore: a backup asked to stage
    copies nothing and fails, rather than writing a stage on the other side
    (701370118)."""
    out = copy(players, "TOREMOTE", STAGE_FLAG + "run1")
    assert "Stage is only for a restore" in out and "SCRIPT-RC=0" not in out, out[-3000:]


@pytest.mark.parametrize("stage", ["/home/fpp/media/config", "/home/fpp/media/tmp/filecopy-stage-../../config",
                                   "/home/fpp/media/tmp/filecopy-stage-", "tmp/filecopy-stage-run1"])
def test_stage_is_refused_anywhere_but_a_stage_folder(players, stage):
    """The script runs as root and empties its stage first, so it takes only
    a tmp/filecopy-stage-<id> folder: anything else is refused, and the
    folder it names is left alone (701370118)."""
    local, _ = players
    write(local / "config" / "keep", "kept")
    out = copy(players, "FROMREMOTE", "Stage:" + stage)
    assert "Invalid stage folder" in out and "SCRIPT-RC=0" not in out, out[-3000:]
    assert (local / "config" / "keep").read_text() == "kept"


@pytest.mark.parametrize("rc,expect", [("0", "BACKUP COMPLETE"), ("1", "BACKUP FAILED (rc=1)")])
def test_the_banner_is_printed_on_its_own_for_copystorage(rc, expect):
    """copystorage.php ends a settings-area restore with the script's own
    banner (--banner <rc>), so the banner text is in one place (701370118)."""
    tree = os.environ.get("FPP_TREE", "")
    script = os.path.join(tree, "scripts", "copy_settings_to_storage.sh")
    if not os.path.exists(script):
        pytest.skip("needs an fpp tree")
    r = subprocess.run(["bash", script, "--banner", rc], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0 and expect in r.stdout and "You may now close this window." in r.stdout, r.stdout + r.stderr
    r = subprocess.run(["bash", script, "--banner", "x; true"], capture_output=True, text=True, timeout=30)
    assert r.returncode != 0 and "BACKUP" not in r.stdout
