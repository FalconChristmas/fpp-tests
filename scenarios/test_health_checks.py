"""The System Health Check's network and time checks (scripts/healthCheck,
the Troubleshooting page and crash report's version, and
scripts/healthCheckSSE, the streamed one), and the LAN gateway fallback
time source that the boot (fppinit setupNetwork) and the NTP server
setting (SetNTPServer) add to chrony's config.

The health checks run from the tree with ping, netstat, timedatectl,
pgrep, chronyc, curl and getent replaced by stand-ins answering as the
case needs (the scenario has no internet and no chrony). The gateway
fallback runs in the fppinit sandbox (fppinit.py) in a network namespace
whose default route is a real one, read with the real ip.
"""

import os
import subprocess
import time

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

TREE = os.environ.get("FPP_TREE", "")

STUBS = {
    # reachable when the address is in $REACHABLE
    "ping": 'for a; do last=$a; done\n'
            'printf "ping %s\\n" "$*" >> "$CALLS"\n'
            'case " $REACHABLE " in *" $last "*) exit 0 ;; esac\nexit 1\n',
    "netstat": 'cat "$ROUTES"\n',
    "timedatectl": 'echo "$NTPSYNC"\n',
    "pgrep": 'case "$*" in *chronyd*) [ -n "$CHRONYD" ] && { echo 4242; exit 0; }; exit 1 ;; esac\nexit 1\n',
    "chronyc": 'echo "Last offset     : +0.000012345 seconds"\n',
    "curl": 'printf "curl %s\\n" "$*" >> "$CALLS"\nexit 7\n',
    "getent": 'echo "140.82.112.3    github.com"\n',
}


def run_checks(tmp_path, script, cut, calls, **env):
    """Run the functions of scripts/<script> (everything before the line
    starting with `cut`, where its main sequence begins), then the shell
    code `calls`, with the stand-ins first on PATH. Returns stdout."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    for name, body in STUBS.items():
        (bindir / name).write_text("#!/bin/sh\n" + body)
        (bindir / name).chmod(0o755)
    with open(os.path.join(TREE, "scripts", script)) as f:
        src = f.read()
    assert cut in src, f"no {cut!r} in {script}"
    scripts = tmp_path / "scripts"
    scripts.mkdir(exist_ok=True)
    if not (scripts / "common").exists():
        (scripts / "common").symlink_to(os.path.join(TREE, "scripts", "common"))
    # common puts /bin and /usr/bin first on PATH; the stand-ins go back in
    # front once it has.
    (scripts / script).write_text(src[:src.index(cut)] + f'\nPATH="{bindir}:$PATH"\n' + calls + "\n")
    routes = tmp_path / "routes"
    routes.write_text(env.pop("routes", ""))
    full = dict(os.environ, FPPDIR=TREE, CALLS=str(tmp_path / "calls"), ROUTES=str(routes))
    full.update({"REACHABLE": "", "NTPSYNC": "yes", "CHRONYD": "", **env})
    r = subprocess.run(["bash", str(scripts / script)], capture_output=True, text=True,
                       timeout=60, env=full)
    return r.stdout + r.stderr


def sse_events(out):
    import json
    return {e["id"]: e for e in (json.loads(l[6:]) for l in out.splitlines() if l.startswith("data: {"))}


ROUTE_HEADER = ("Kernel IP routing table\n"
                "Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface\n")


def sse_network_chain(tmp_path, **env):
    """healthCheckSSE's network and time chain, as the script runs it."""
    with open(os.path.join(TREE, "scripts", "healthCheckSSE")) as f:
        src = f.read()
    chain = src[src.index("# Network chain order"):src.index("# Storage")]
    return sse_events(run_checks(tmp_path, "healthCheckSSE", "# Run all health checks", chain, **env))


def test_one_unreachable_gateway_of_two_warns_and_the_checks_go_on(tmp_path):
    """With two default gateways, one answering, the streamed health check
    warns (multiple gateways, 1 of 2 reachable) and still checks internet
    access, DNS and the time; with neither answering the gateway check
    fails and the rest are skipped.

    Regression: 758f5d0ad. Two gateways failed the gateway check outright,
    only the first one was pinged, and the internet, DNS and NTP checks
    were all skipped.
    """
    routes = ROUTE_HEADER + ("0.0.0.0         10.9.0.1        0.0.0.0         UG        0 0          0 eth0\n"
                             "0.0.0.0         10.9.1.1        0.0.0.0         UG        0 0          0 wlan0\n")
    ev = sse_network_chain(tmp_path, routes=routes, REACHABLE="10.9.1.1 1.1.1.1")
    assert ev["gateway"]["status"] == "warn", ev
    assert ev["gateway_ping"]["status"] == "warn", ev
    assert ev["gateway_ping"]["message"] == "1 of 2 gateways reachable", ev
    for later in ("internet", "dns", "ntp"):
        assert ev.get(later, {}).get("status") == "pass", f"{later} not checked: {ev}"

    ev = sse_network_chain(tmp_path, routes=routes, REACHABLE="1.1.1.1")
    assert ev["gateway_ping"]["status"] == "fail", ev
    assert "internet" not in ev, ev


def test_internet_access_is_a_ping_to_a_public_resolver(tmp_path):
    """The Troubleshooting health check finds internet access by pinging
    1.1.1.1, 8.8.8.8 or 9.9.9.9 -- an address, as DNS may not work --
    and reports it missing when none answers.

    Regression: c2e0c272c (#2180). The check fetched a web page from one
    fixed server address (then a second), so a server moving or refusing
    the request read as no internet on a box that had it.
    """
    calls = "HC_Internet"
    out = run_checks(tmp_path, "healthCheck", "# Main Health Check routines here", calls,
                     REACHABLE="8.8.8.8")
    assert "Internet connectivity confirmed." in out, out[-2000:]
    out = run_checks(tmp_path, "healthCheck", "# Main Health Check routines here", calls)
    assert "Internet connectivity check unsuccessful." in out, out[-2000:]


@pytest.mark.parametrize("script", ["healthCheck", "healthCheckSSE"])
def test_a_clock_ntp_never_synchronized_is_not_reported_as_synchronized(tmp_path, script):
    """When the system says NTP is not synchronized, the time check says so
    (a warning while chronyd runs, a failure when it doesn't) instead of
    passing; when it is synchronized the offset decides as before.

    Regression: 48a937466 (#2736, part B). The check looked only at the
    daemon's last offset, which on a box that had never reached a time
    server was 0, so it reported the time synchronized.
    """
    if script == "healthCheck":
        cut, calls = "# Main Health Check routines here", "HC_NTPOffset"
        def result(out):
            return out
    else:
        cut, calls = "# Run all health checks", "HC_NTPOffset"
        def result(out):
            return sse_events(out)["ntp"]["message"]
    running = result(run_checks(tmp_path, script, cut, calls, NTPSYNC="no", CHRONYD="1"))
    assert "NTP daemon not synchronized" in running, running
    stopped = result(run_checks(tmp_path, script, cut, calls, NTPSYNC="no"))
    assert "NTP daemon not running" in stopped, stopped
    synced = result(run_checks(tmp_path, script, cut, calls, NTPSYNC="yes", CHRONYD="1"))
    assert "not synchronized" not in synced and "not running" not in synced, synced


GATEWAY = "192.168.40.254"
CHRONY = "/etc/chrony/chrony.conf"
BASE_CONF = "pool falconplayer.pool.ntp.org iburst minpoll 8 maxpoll 12\nallow all\nlocal stratum 10\n"

# A network namespace whose default route goes through GATEWAY, set up with
# the real ip before the command runs.
WITH_ROUTE = ("ip link add fpptest0 type veth peer name fpptest1 && ip link set fpptest1 up && "
              "ip addr add 192.168.40.2/24 dev fpptest0 && ip link set fpptest0 up && "
              f"ip route add default via {GATEWAY} && ")


def in_routed_netns(sb, command, **kw):
    r = sb._run(["unshare", "--net", "sh", "-c", WITH_ROUTE + command], **kw)
    if "fpptest0" in r.stderr and "RTNETLINK" in r.stderr:
        pytest.skip(f"no veth pair here: {r.stderr.strip()[-300:]}")
    return r


def gateway_lines(conf):
    return [l for l in (conf or "").splitlines() if l.startswith(f"server {GATEWAY} ")]


def test_boot_adds_the_lan_gateway_as_a_fallback_time_source(fppinit):
    """setupNetwork at boot adds the default gateway to chrony's config as a
    fallback time server, once (a config that has it is left alone), and
    has chrony pick it up.

    Regression: 48a937466 (#2736, part A). Behind a double NAT that drops
    NTP to the internet, the pool was the only source and the clock never
    synchronized, though the LAN gateway usually answers NTP.
    """
    for d in ("/etc/wpa_supplicant", "/etc/systemd/network", "/etc/hostapd"):
        fppinit.root_file(d + "/.fpp-test", "")
    fppinit.root_file(CHRONY, BASE_CONF)
    r = in_routed_netns(fppinit, "exec /opt/fpp/src/fppinit setupNetwork", timeout=300)
    conf = fppinit.written(CHRONY)
    assert len(gateway_lines(conf)) == 1, f"{conf!r}\n{(r.stdout + r.stderr)[-2000:]}"
    assert conf.startswith(BASE_CONF), conf
    assert any("chrony" in c and ("restart" in c or "reload" in c) for c in fppinit.calls()), fppinit.calls()

    fppinit.root_file(CHRONY, conf)
    in_routed_netns(fppinit, "exec /opt/fpp/src/fppinit setupNetwork", timeout=300)
    again = fppinit.written(CHRONY)
    assert again is None or len(gateway_lines(again)) == 1, again


def test_saving_the_ntp_server_keeps_the_lan_gateway_fallback(fppinit):
    """Saving the NTP server setting (SetNTPServer) rewrites chrony's source
    line and adds the default gateway as a fallback server, once.

    Regression: 48a937466 (#2736, part A), the settings half: without it a
    save dropped back to the pool alone until the next boot.
    """
    fppinit.root_file(CHRONY, BASE_CONF)
    php = ("php -d short_open_tag=1 -r 'include \"/opt/fpp/www/common/settings.php\"; "
           "SetNTPServer(\"10.1.2.3\"); SetNTPServer(\"10.1.2.3\");'")
    r = in_routed_netns(fppinit, php, timeout=120)
    conf = fppinit.written(CHRONY)
    out = r.stdout + r.stderr
    assert conf and "server 10.1.2.3 iburst" in conf and "pool " not in conf, f"{conf!r}\n{out[-2000:]}"
    assert len(gateway_lines(conf)) == 1, f"{conf!r}\n{out[-2000:]}"


HC_MAIN = "# Main Health Check routines here"


@pytest.mark.parametrize("off, want", [
    (0, "aligned to the browser"),
    (20 * 60, "more than 10 mins different"),
    (-20 * 60, "more than 10 mins different"),
    (6 * 3600, "significantly different"),
])
def test_the_browser_time_check_warns_past_10_minutes_and_fails_past_4_hours(tmp_path, off, want):
    """The date/time check against the browser's clock passes within 10
    minutes, warns beyond that, and fails beyond 4 hours.

    Regression: 713679369. The warning branch sat inside the failure one
    with its comparisons reversed, so 10 minutes to 4 hours off passed, and
    past 4 hours it warned instead of failing."""
    out = run_checks(tmp_path, "healthCheck", HC_MAIN, "HC_DateTime",
                     BROWSER_TIME=str(int(time.time()) - off))
    assert want in out, out[-2000:]


def test_the_health_check_lists_fppds_warnings(tmp_path):
    """The FPPD Warnings item lists the warnings fppd has up, from
    www/warnings.json, with their count, and says so when there are none.

    Regression: 2e712086e (the check's introduction)."""
    fake = tmp_path / "fpp"
    (fake / "www").mkdir(parents=True)
    (fake / "www" / "warnings.json").write_text('["Disk nearly full", "MQTT Disconnected"]')
    out = run_checks(tmp_path, "healthCheck", HC_MAIN, "HC_Warnings", FPPDIR=str(fake))
    assert "2 FPPD WARNINGS: Disk nearly full,MQTT Disconnected" in out, out[-2000:]
    (fake / "www" / "warnings.json").write_text("[]")
    out = run_checks(tmp_path, "healthCheck", HC_MAIN, "HC_Warnings", FPPDIR=str(fake))
    assert "No Warnings Found" in out, out[-2000:]


def test_the_health_check_says_when_the_fppd_executable_is_missing(tmp_path):
    """With no src/fppd in the tree the FPPD item says the executable is
    missing and needs a rebuild, rather than only that fppd isn't running.

    Regression: 9bcb69eef."""
    fake = tmp_path / "fpp"
    (fake / "src").mkdir(parents=True)
    out = run_checks(tmp_path, "healthCheck", HC_MAIN, "HC_FPPD", FPPDIR=str(fake))
    assert "FPPD executable is missing. Rebuild required." in out, out[-2000:]


@pytest.mark.parametrize("status, label", [(1, "Pass"), (2, "Warning"), (0, "Fail")])
def test_the_text_report_labels_each_status(tmp_path, status, label):
    """Run without --php (the copy a crash report carries in
    logs/healthCheck.log), each item reads Pass, Warning or Fail by its
    status.

    Regression: c9ddc60bf. The Warning label sat inside the Fail branch,
    where a warning's status never reaches, so warnings read "Pass" (since
    3259a36ac)."""
    out = run_checks(tmp_path, "healthCheck", HC_MAIN,
                     f'PrintItemHead "fpp-tests item"; STATUS={status}; '
                     f'STATUSSTR="fpp-tests status"; PrintItemFoot')
    assert f"{label} - fpp-tests status" in out, out[-2000:]
