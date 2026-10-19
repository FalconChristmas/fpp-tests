"""Serve FPP's web UI from a built tree, for the web suite (run-web.sh).

Runs inside the web container. Starts fppd the way a scenario does (fresh
media directory, sanitizer logging) and Apache + php-fpm in front of it with
the tree's own site config, prints READY, and serves until SIGTERM. Then it
checks fppd the way a scenario's teardown does: it must still be running, must
exit 0 on SIGTERM, and must have produced no sanitizer report. The verdict goes
to $FPP_TESTS_ARTIFACTS/fppd.json, and on failure the media directory (logs,
backtrace, config) and Apache's logs are copied next to it.
"""

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
    artifacts = os.environ.get("FPP_TESTS_ARTIFACTS", "/artifacts")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    # The site config, the CSP generator and a few pages name /opt/fpp.
    if os.path.lexists("/opt/fpp"):
        os.unlink("/opt/fpp")
    os.symlink(tree, "/opt/fpp")

    f = Fppd(tree)
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
    f.start(timeout=120)

    # The CSP is generated per device from its settings and cape; the pages
    # see whatever this tree's generator writes for a fresh player. It ends by
    # reloading Apache through systemd, which fails here (Apache starts below),
    # so judge it by the file it writes rather than by its exit status.
    csp = os.path.join(tree, "etc", "apache2.csp")
    if os.path.exists(csp):
        os.unlink(csp)
    subprocess.run(["/opt/fpp/scripts/ManageApacheContentPolicy.sh", "regenerate"])
    if not os.path.exists(csp):
        raise RuntimeError("ManageApacheContentPolicy.sh regenerate wrote no etc/apache2.csp")
    shutil.copy(os.path.join(tree, "etc", "apache2.site"), "/etc/apache2/sites-enabled/000-default.conf")
    shutil.copy(os.path.join(tree, "etc", "apache2.status"), "/etc/apache2/mods-enabled/status.conf")
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
        print(f.tail(), flush=True)
        shutil.copytree(f.media, os.path.join(artifacts, "media"), symlinks=True, dirs_exist_ok=True)
    shutil.copytree("/var/log/apache2", os.path.join(artifacts, "apache2"), dirs_exist_ok=True)
    subprocess.run(["apache2ctl", "stop"])
    f.cleanup()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
