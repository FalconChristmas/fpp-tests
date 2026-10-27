"""fppd's FileMonitor: config files it watches are reloaded however they are
replaced."""

import os
import time
import urllib.error


def set_volume(value):
    """A preset that sets the volume, so a scenario can see which version of
    the file fppd has loaded (Volume Set, as Set Variable is newer than the
    fix)."""
    return {"name": "P", "command": "Volume Set", "args": [str(value)], "presetSlot": 0}


def loaded(fppd, value):
    def check():
        fppd.command("Trigger Command Preset", "P", timeout=5)
        return fppd.get("/fppd/volume", timeout=5).get("volume") == value
    return check


def test_a_file_replaced_by_rename_is_reloaded_every_time(fppd):
    """commandPresets.json replaced by writing a temp file and renaming it over
    the old one -- how FPP's own writers save config files -- is reloaded, and
    so is the next replacement made the same way.

    Regression: 21e9df1e5. The directory watch asked for IN_CREATE and
    IN_DELETE but not IN_MOVED_TO, and the watch on the replaced file's inode
    went with that inode, so a file renamed into place was never reloaded.
    Each replacement here is stamped in its own later second, so the
    whole-second mtime check fixed in ad22d9f73 can't hide one."""
    fppd.write("config/commandPresets.json", {"commands": [set_volume(11)]})
    fppd.start()
    fppd.wait_for(loaded(fppd, 11), timeout=10, interval=0.25, what="the presets to load")

    path = os.path.join(fppd.media, "config", "commandPresets.json")
    base = int(time.time()) + 5
    for i, value in enumerate((22, 33)):
        tmp = fppd.write("config/.commandPresets.json.tmp", {"commands": [set_volume(value)]})
        stamp = (base + 5 * i) * 1_000_000_000
        os.utime(tmp, ns=(stamp, stamp))
        os.rename(tmp, path)
        fppd.wait_for(loaded(fppd, value), timeout=15, interval=0.25,
                      what=f"replacement {i + 1} (volume {value}) to load")


def test_a_deleted_file_is_reloaded(fppd):
    """Deleting commandPresets.json while fppd runs drops its presets: the
    watcher hears the delete. Then a preset that set the volume no longer
    does.

    Regression: 9c24621b0. FileMonitor ran a deleted file's callbacks
    only while the file still had its own inode watch. The kernel frees the
    inode inside the unlink and queues that watch's IN_IGNORED ahead of the
    directory's IN_DELETE, which cleared the watch first, so the delete was
    never passed on and fppd kept the deleted file's contents."""
    fppd.write("config/commandPresets.json", {"commands": [set_volume(11)]})
    fppd.start()
    fppd.wait_for(loaded(fppd, 11), timeout=10, interval=0.25, what="the presets to load")

    os.unlink(os.path.join(fppd.media, "config", "commandPresets.json"))

    def gone():
        fppd.command("Volume Set", "50", timeout=5)
        try:
            fppd.command("Trigger Command Preset", "P", timeout=5)
        except urllib.error.HTTPError:
            pass
        return fppd.get("/fppd/volume", timeout=5).get("volume") == 50
    fppd.wait_for(gone, timeout=10, interval=0.5, what="the deleted presets to be dropped")
