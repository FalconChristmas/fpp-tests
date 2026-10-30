"""Serve FPP's web UI from a built tree, for the web suite (run-web.sh).

Runs inside the web container. Starts fppd the way a scenario does (fresh
media directory, sanitizer logging) and Apache + php-fpm in front of it with
the tree's own site config, prints READY, and serves until SIGTERM. Then it
checks fppd the way a scenario's teardown does: it must still be running, must
exit 0 on SIGTERM, and must have produced no sanitizer report. The verdict goes
to $FPP_TESTS_ARTIFACTS/fppd.json, and on failure the media directory (logs,
backtrace, config) and Apache's logs are copied next to it.
"""

import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scenarios"))
from fppd import Fppd  # noqa: E402


def sh(*cmd):
    subprocess.run(cmd, check=True)


def main():
    tree = os.environ["FPP_TREE"]
    # Held while serving, so tree eviction (prepare-tree.sh) skips this tree.
    tree_lock = os.open(tree, os.O_RDONLY)
    fcntl.flock(tree_lock, fcntl.LOCK_SH)
    artifacts = os.environ.get("FPP_TESTS_ARTIFACTS", "/artifacts")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    # The site config, the CSP generator and a few pages name /opt/fpp. The
    # tree is shared with every other run of the same commit, scenarios
    # included, and fppd writes into it: www/media_root.txt, which PHP reads
    # to find the media directory, and www/warnings.json, which it puts next
    # to the src/ it runs from; the CSP generator below writes etc/. PHP
    # scripts under scripts/ find the tree from their real path (__DIR__), so
    # a linked scripts/ would read the shared www/media_root.txt. So this
    # container serves and runs its own copies of those, and links the rest
    # of the tree in.
    if os.path.lexists("/opt/fpp"):
        if os.path.islink("/opt/fpp"):
            os.unlink("/opt/fpp")
        else:
            shutil.rmtree("/opt/fpp")
    os.makedirs("/opt/fpp")
    for entry in os.listdir(tree):
        if entry in ("www", "src", "etc", "scripts"):
            shutil.copytree(os.path.join(tree, entry), os.path.join("/opt/fpp", entry), symlinks=True)
        else:
            os.symlink(os.path.join(tree, entry), os.path.join("/opt/fpp", entry))

    f = Fppd("/opt/fpp")

    # The site config and some scripts name the device's media directory
    # rather than reading www/media_root.txt.
    os.makedirs("/home/fpp", exist_ok=True)
    if os.path.lexists("/home/fpp/media"):
        os.unlink("/home/fpp/media")
    os.symlink(f.media, "/home/fpp/media")
    # Apache serves some of it directly (virtualdisplay_assets), as the fpp
    # user on a device but as www-data here, which a private temp dir shuts out.
    os.chmod(f.media, 0o755)
    # What `fppinit start` writes at boot on a player with no UI password
    # (setupApache() in src/boot/FPPINIT_Config.cpp): the site config itself
    # admits only local clients, and this include opens it to the LAN -- here,
    # to the host's browser coming in through Docker's port mapping.
    f.write("config/ui-password-config.conf",
            "<RequireAny>\n  Require all granted\n</RequireAny>\n\nSetEnvIf Host ^ LOCAL_PROTECT=0\n")
    # An event file, as a player upgraded from FPP 4 still has one. With no
    # commandPresets.json yet, fppd's first start turns it into a Command
    # Preset of the same name, which /api/events/01_01/trigger then fires
    # (tests/events.spec.ts). Nothing in the API writes the events directory.
    f.write("events/01_01.fevt", {
        "majorId": 1, "minorId": 1, "name": "fpp-tests event",
        "command": "Set Variable", "args": ["fppTestsEvent", "Value", "1", "1", "0", "100", ""],
    })
    # An overlay model, and an xLights submodel and model group of it as
    # xLights' FPP Connect exports them, for the Pixel Overlay Models page
    # and the command pickers (tests/overlay-models-ui.spec.ts). fppd reads
    # model-overlays.json only at start.
    f.write("config/model-overlays.json", {"models": [{
        "Name": "fpp-tests-matrix", "Type": "Channel", "StartChannel": 1, "ChannelCount": 150,
        "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": 5, "StrandsPerString": 1, "xLights": True}]})
    f.write("config/xlights-submodels.json", {"source": "xlights", "version": 1, "submodels": [{
        "Name": "fpp-tests-matrix-cells", "DisplayName": "fpp-tests-matrix-cells", "Type": "Sub",
        "SubType": "grid", "Parent": "fpp-tests-matrix", "ParentStartChannel": 1,
        "ChannelCountPerNode": 3, "Width": 3, "Height": 2, "Grid": "1,2,3;11,12,13"}]})
    f.write("config/xlights-modelgroups.json", {"source": "xlights", "version": 1, "modelgroups": [{
        "Name": "fpp-tests-group", "DisplayName": "fpp-tests-group", "Type": "Sub",
        "SubType": "channelgrid", "IsGroup": True, "ChannelCountPerNode": 3, "Width": 2,
        "Height": 1, "Orientation": "horizontal", "StartCorner": "TL", "StringCount": 1,
        "StrandsPerString": 1, "MemberCount": 1, "PixelCount": 2, "Grid": "1,4"}]})
    peer = bool(os.environ.get("FPP_TESTS_PEER"))
    if peer:
        # A second player (web/tests/second-player.ts) loses its media, logs
        # included, with its container, so what it was asked to do has to be
        # in the log printed below.
        f.settings(**{f"LogLevel_{c}": "debug" for c in ("General", "Control", "HTTP", "Command", "Sync", "Settings")})
    f.start(timeout=120)

    # The CSP is generated per device from its settings and cape; the pages
    # see whatever this tree's generator writes for a fresh player. It ends by
    # reloading Apache through systemd, which fails here (Apache starts below),
    # so judge it by the file it writes rather than by its exit status.
    csp = "/opt/fpp/etc/apache2.csp"
    if os.path.exists(csp):
        os.unlink(csp)
    subprocess.run(["/opt/fpp/scripts/ManageApacheContentPolicy.sh", "regenerate"])
    if not os.path.exists(csp):
        raise RuntimeError("ManageApacheContentPolicy.sh regenerate wrote no etc/apache2.csp")
    shutil.copy("/opt/fpp/etc/apache2.site", "/etc/apache2/sites-enabled/000-default.conf")
    shutil.copy("/opt/fpp/etc/apache2.status", "/etc/apache2/mods-enabled/status.conf")
    os.makedirs("/run/php", exist_ok=True)
    sh("php-fpm8.4", "-R")
    sh("apache2ctl", "start")
    print("READY", flush=True)

    while not stop.wait(1):
        if f.proc.poll() is not None:
            break

    verdict = {"alive": f.proc.poll() is None}
    failed = not verdict["alive"]
    if verdict["alive"]:
        try:
            f.get("/fppd/status", timeout=10)
        except Exception as e:
            # Wedged: take every thread's stack before stopping it.
            verdict["wedged"] = str(e)
            failed = True
            try:
                f.backtrace()
            except Exception as bt:
                print(f"could not take a backtrace: {bt}", flush=True)
        try:
            verdict["exit"] = f.stop()
        except TimeoutError as e:
            verdict["exit"] = str(e)
    else:
        verdict["exit"] = f.proc.returncode
    reports = f.sanitizer_reports()
    verdict["sanitizer_reports"] = [r[:8000] for r in reports]
    failed = failed or verdict["exit"] != 0 or bool(reports)
    verdict["ok"] = not failed

    os.makedirs(artifacts, exist_ok=True)
    with open(os.path.join(artifacts, "fppd.json"), "w") as out:
        json.dump(verdict, out, indent=2)
    if failed:
        # The verdict too: a second player's artifacts are on its own tmpfs,
        # so its log is all that is left of them.
        print(json.dumps({k: v for k, v in verdict.items() if k != "sanitizer_reports"}), flush=True)
        for r in reports:
            print(r[:4000], flush=True)
        print(f.tail(300 if peer else 40), flush=True)
        shutil.copytree(f.media, os.path.join(artifacts, "media"), symlinks=True, dirs_exist_ok=True)
    shutil.copytree("/var/log/apache2", os.path.join(artifacts, "apache2"), dirs_exist_ok=True)
    subprocess.run(["apache2ctl", "stop"])
    f.cleanup()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
