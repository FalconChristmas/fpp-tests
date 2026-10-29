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
cd /tmp
set +e
bash "$TREE/scripts/copy_settings_to_storage.sh" 127.0.0.1 fpp-test "$DIRECTION" none no no "$@"
echo "SCRIPT-RC=$?"
kill $DAEMON
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


def copy(players, direction, *flags):
    local, remote = players
    r = subprocess.run(["unshare", "--mount", "--net", "--propagation", "private", "bash", "-c", RUN,
                        "bash", os.environ["FPP_TREE"], str(local), str(remote), direction, *flags],
                       capture_output=True, text=True, timeout=180)
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
