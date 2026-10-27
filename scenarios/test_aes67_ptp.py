"""AES67's PTP: how ptp4l is started and configured, and what pmc's answers
make of the clock.

AES67Manager writes a ptp4l config, starts ptp4l, and then asks pmc for the
port state, the grandmaster and the offset: that answer decides whether the
streams start on a locked clock, what /aes67/status reports, and which clock
the SDP names. The test container has no linuxptp, so ptp_standin.py makes
stand-ins that save how they were started and answer pmc's queries from files
the scenario writes -- the scenario plays the PTP domain.

Each config here has one send instance. With no PipeWire running its pipeline
fails at once, which raises the stream's own warning and nothing else, and
leaves no pipeline for the watchdog to rebuild.
"""

import os
import socket
import struct
import time

import pytest

from ptp_standin import ptp_standins

NO_LOCK = ("AES67: PTP did not reach a usable lock before the streams started — "
           "audio may be mistimed until the clock settles")
NOT_INSTALLED = "AES67: ptp4l not found — install the linuxptp package"
CONFIG = "config/pipewire-aes67-instances.json"


def write_config(fppd, **top):
    cfg = {"ptpEnabled": True, "ptpInterface": "lo", "ptpLockWaitMs": 0,
           "instances": [{"id": 1, "name": "tx", "mode": "send", "enabled": True,
                          "sapEnabled": False, "multicastIP": "127.0.0.1", "port": 5004}]}
    cfg.update(top)
    fppd.write(CONFIG, cfg)


def start(fppd, ptp=None):
    fppd.settings(MediaBackend="pipewire")
    fppd.start(extra_env=ptp.env() if ptp else None)
    applied(fppd, 1)


def applied(fppd, n):
    """Wait for the n-th "Applied config" (at startup, then one per apply)."""
    fppd.wait_for(lambda: fppd.log().count("AES67Manager: Applied config") >= n, timeout=60,
                  what=f"AES67 config apply #{n}")


def apply(fppd):
    n = fppd.log().count("AES67Manager: Applied config")
    fppd.command("AES67 Apply", timeout=60)
    applied(fppd, n + 1)


def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def ptp_status(fppd):
    return fppd.get("/aes67/status")["ptp"]


@pytest.fixture
def ptp(fppd):
    p = ptp_standins(fppd)
    yield p
    p.cleanup()


def test_ptp4l_config_follows_the_ptp_settings(fppd, ptp):
    """Domain 5 as a follower: ptp4l gets domainNumber 5 and the follower key
    set, steps a large offset (step_threshold 1), marks its packets EF
    (DSCP 46), and pmc is asked on domain 5.

    Feature: 585407e7a (PTP domain and role settings). Regression: 2f49af45d --
    without step_threshold linuxptp only steps on the first correction and
    slews anything after it, which takes hours past a second. 6e4285446 added
    the DSCP marking and pmc's -d, without which ptp4l drops every management
    query on any domain but 0. ddc893f73: a linuxptp that knows clientOnly
    (the probe does not call it unknown) is given clientOnly, not the
    deprecated slaveOnly.

    Feature: 79caf3748 (ptp4l in place of gst-ptp-helper)."""
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd, ptpDomain=5, ptpRole="follower")
    start(fppd, ptp)
    conf = fppd.wait_for(lambda: ptp.conf(), timeout=30, what="ptp4l to be started")
    # Every difference at once, so one control build shows each cause.
    want = {"domainNumber": "5", "clientOnly": "1", "step_threshold": "1",
            "dscp_event": "46", "dscp_general": "46"}
    problems = [f"{k} is {conf.get(k)!r}, not {v!r}" for k, v in want.items() if conf.get(k) != v]
    if "slaveOnly" in conf:
        problems.append("slaveOnly written")
    st = ptp_status(fppd)  # asks pmc
    if (st["domain"], st["role"]) != (5, "follower"):
        problems.append(f"status domain/role {st['domain']}/{st['role']}")
    argv = ptp.argv("pmc") or []
    if "-d" not in argv or argv[argv.index("-d") + 1] != "5":
        problems.append(f"pmc not asked on domain 5: {argv}")
    assert not problems, "\n".join(problems) + f"\n{conf}"


def test_ptp4l_master_role_outbids_other_clocks(fppd, ptp):
    """Role "master" gives ptp4l priority1 127, under the 128 that other
    gear ships with, and leaves the follower key off.

    Feature: 585407e7a."""
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd, ptpRole="master")
    start(fppd, ptp)
    conf = fppd.wait_for(lambda: ptp.conf(), timeout=30, what="ptp4l to be started")
    assert conf.get("priority1") == "127", conf
    assert conf.get("clientOnly") == "0", conf


def test_old_linuxptp_is_given_slaveOnly(fppd, ptp):
    """A ptp4l whose config parser does not know clientOnly (linuxptp before
    4.0) is given slaveOnly: an unknown key makes ptp4l exit before it does
    anything.

    Feature: ddc893f73 (the follower key is probed, not hard-coded)."""
    ptp.unknown_option("clientOnly")
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd, ptpRole="follower")
    start(fppd, ptp)
    conf = fppd.wait_for(lambda: ptp.conf(), timeout=30, what="ptp4l to be started")
    assert conf.get("slaveOnly") == "1" and "clientOnly" not in conf, conf


def test_invalid_ptp_domain_and_role_fall_back(fppd, ptp):
    """ptpDomain 200 (a PTP header carries 0-127) and ptpRole "bogus" are
    reported and replaced by domain 0 and role "auto" (priority1 248, not a
    follower).

    Feature: 585407e7a."""
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd, ptpDomain=200, ptpRole="bogus")
    start(fppd, ptp)
    conf = fppd.wait_for(lambda: ptp.conf(), timeout=30, what="ptp4l to be started")
    assert conf.get("domainNumber") == "0", conf
    assert (conf.get("priority1"), conf.get("clientOnly")) == ("248", "0"), conf
    log = fppd.log()
    assert "Invalid PTP domain 200" in log
    assert "Unknown PTP role 'bogus'" in log
    st = ptp_status(fppd)
    assert (st["domain"], st["role"]) == (0, "auto"), st


def test_blank_ptp_interface_uses_a_wired_one(fppd, ptp):
    """A config with ptpInterface "" (what older pages saved as "(Default)")
    starts ptp4l on a real interface, never with -i "".

    Regression: 99e32fe31. ptp4l was exec'd with -i "", which makes it exit
    at once, so PTP never ran on such a config."""
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd, ptpInterface="")
    start(fppd, ptp)
    argv = fppd.wait_for(lambda: ptp.argv(), timeout=30, what="ptp4l to be started")
    iface = argv[argv.index("-i") + 1]
    assert iface not in ("", "lo"), argv
    assert f"no PTP interface configured, using {iface}" in fppd.log()


def test_phc2sys_is_never_started(fppd):
    """With a PHC (/dev/ptp0) and phc2sys installed, starting PTP and
    applying the config again never runs phc2sys.

    Regression: 0c8eaad58. "phc2sys -a -r" was started next to ptp4l and
    slaved CLOCK_REALTIME to the grandmaster's timescale, which on Dante gear
    is time since that device booted: it dragged the system clock to 1970.

    /dev/ptp0 is made as an empty file, inside the test container only:
    nothing opens it for an interface (lo) that has no PHC."""
    p = ptp_standins(fppd, phc2sys=True)
    try:
        if os.path.exists("/dev/ptp0"):
            pytest.skip("this machine has a PHC")
        p.touch("/dev/ptp0")
        p.answer(port_state="LISTENING", gm_present="false")
        write_config(fppd)
        start(fppd, p)
        fppd.wait_for(lambda: p.argv(), timeout=30, what="ptp4l to be started")
        # A new domain restarts ptp4l (the path the start took); the same
        # settings keep it (the rebuild path).
        write_config(fppd, ptpDomain=3)
        apply(fppd)
        apply(fppd)
        time.sleep(1)
        assert p.argv("phc2sys") is None, f"phc2sys was started: {p.argv('phc2sys')}"
    finally:
        p.cleanup()


@pytest.mark.parametrize("answer", [
    pytest.param(dict(gm_present=None, master_offset=1000), id="no-gmPresent"),
    pytest.param(dict(gm_present="maybe", master_offset=1000), id="malformed-gmPresent"),
    pytest.param(dict(gm_present="true", master_offset=None), id="no-offset"),
    pytest.param(dict(gm_present="true", master_offset="garbage"), id="non-numeric-offset"),
    pytest.param(dict(gm_present="true", master_offset="12abc"), id="trailing-junk-offset"),
])
def test_slave_without_evidence_is_not_a_lock(fppd, ptp, answer):
    """pmc says SLAVE, but its answer lacks a gmPresent that reads true or
    false, or a master_offset that parses whole: the lock wait runs out
    ("did not settle"), the no-lock warning goes up, the status says the
    streams were not started locked, and /aes67/status reports the offset as
    null, not 0.

    Regression: 32fd04e98 -- a missing field left the offset at 0, which
    passed for a perfect lock; that is what #2848 settled on before its clock
    stepped 6.8 hours. ee032b749: the status reported such an offset as 0
    (synced, offset 0 ns) rather than unknown."""
    ptp.answer(port_state="SLAVE", gm_identity="aabbcc.fffe.ddeeff", **answer)
    write_config(fppd, ptpLockWaitMs=1500)
    start(fppd, ptp)
    log = fppd.log()
    st = ptp_status(fppd)
    problems = []
    if "PTP settled after" in log:
        problems.append("settled on a SLAVE answer with no evidence")
    if "PTP did not settle within 1500ms" not in log:
        problems.append("no did-not-settle log")
    if NO_LOCK not in warnings(fppd):
        problems.append("no no-lock warning")
    if st["lockedAtStart"] is not False:
        problems.append("lockedAtStart")
    if st["offsetNs"] is not None:
        problems.append(f"offsetNs {st['offsetNs']!r}, not null")
    assert not problems, "\n".join(problems) + f"\n{st}"


def test_slave_with_a_small_offset_is_a_lock(fppd, ptp):
    """SLAVE with gmPresent true and master_offset +1000 ns settles the wait
    at once, with no warning; the status names the grandmaster (pmc's
    aabbcc.fffe.ddeeff as AA-BB-CC-FF-FE-DD-EE-FF) and its offset, and the
    exported SDP's ts-refclk names that grandmaster, not this box's own clock.

    Feature: 6e4285446 (the grandmaster and offset come from pmc). The
    positive half of 32fd04e98 / ee032b749: evidence does make a lock."""
    ptp.answer(port_state="SLAVE", gm_present="true", gm_identity="aabbcc.fffe.ddeeff",
               master_offset=1000)
    write_config(fppd, ptpLockWaitMs=10000)
    t = time.monotonic()
    start(fppd, ptp)
    assert time.monotonic() - t < 9, "the wait ran to its cap"
    assert "PTP settled after" in fppd.log() and "SLAVE, offset +1000ns" in fppd.log()
    assert NO_LOCK not in warnings(fppd)
    st = ptp_status(fppd)
    assert st["lockedAtStart"] is True, st
    assert (st["synced"], st["offsetNs"], st["grandmasterId"]) == \
        (True, 1000, "AA-BB-CC-FF-FE-DD-EE-FF"), st
    assert st["isGrandmaster"] is False, st
    sdp = fppd.get("/aes67/sdp")["streams"][0]["sdp"]
    assert "a=ts-refclk:ptp=IEEE1588-2008:AA-BB-CC-FF-FE-DD-EE-FF:0" in sdp, sdp


def test_lock_wait_outcomes(fppd, ptp):
    """The three ways the lock wait ends, one fppd, applied in turn:

    - UNCALIBRATED (a grandmaster is there, we have not caught up) for the
      whole wait: the streams start anyway, the no-lock warning goes up and
      lockedAtStart is false.
    - LISTENING with gmPresent false at the deadline: no grandmaster on the
      domain, nothing to step the clock, so no warning and lockedAtStart.
    - MASTER: settled as soon as it is seen, well inside the cap.

    Feature: 42b49e6aa (PTP lock wait and its status)."""
    ptp.answer(port_state="UNCALIBRATED", gm_present="true", master_offset=5000000)
    write_config(fppd, ptpLockWaitMs=1500)
    start(fppd, ptp)
    assert "PTP did not settle within 1500ms (state UNCALIBRATED)" in fppd.log()
    assert NO_LOCK in warnings(fppd)
    assert ptp_status(fppd)["lockedAtStart"] is False
    assert fppd.get("/aes67/status")["active"] is True

    # A changed domain restarts ptp4l, and with it the wait.
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd, ptpLockWaitMs=1500, ptpDomain=1)
    apply(fppd)
    assert "no PTP grandmaster on domain 1" in fppd.log()
    assert NO_LOCK not in warnings(fppd)
    assert ptp_status(fppd)["lockedAtStart"] is True

    ptp.answer(port_state="MASTER", gm_present="false")
    write_config(fppd, ptpLockWaitMs=20000, ptpDomain=2)
    t = time.monotonic()
    apply(fppd)
    assert time.monotonic() - t < 15, "MASTER waited out the cap"
    assert "this node is the grandmaster" in fppd.log()
    assert ptp_status(fppd)["lockedAtStart"] is True


@pytest.mark.parametrize("state,grandmaster", [("MASTER", True), ("GRAND_MASTER", True),
                                               ("PRE_MASTER", False), ("SLAVE", False)])
def test_status_reports_this_box_as_grandmaster(fppd, ptp, state, grandmaster):
    """pmc's port state decides whether /aes67/status reports this box as the
    grandmaster: MASTER or GRAND_MASTER is, and then it is synced to itself
    (its own clock id, offset 0) although pmc says gmPresent false;
    PRE_MASTER (on the way there) and SLAVE are not.

    Regression: a641f718d. A box that had won the election was reported as
    not synced, since pmc reports no remote grandmaster for it."""
    ptp.answer(port_state=state, gm_present="false")
    write_config(fppd)
    start(fppd, ptp)
    st = fppd.wait_for(lambda: (s := ptp_status(fppd))["portState"] == state and s,
                       timeout=10, what=f"portState {state}")
    assert st["isGrandmaster"] is grandmaster, st
    if grandmaster:
        # lo's all-zero MAC as an EUI-64
        assert (st["synced"], st["grandmasterId"], st["offsetNs"]) == \
            (True, "00-00-00-FF-FE-00-00-00", 0), st
    else:
        assert (st["synced"], st["grandmasterId"]) == (False, ""), st


def announce(origin, gm_id, steps_removed, domain=0):
    """A PTPv2 Announce (from origin, to fppd's PTP port 320 on 127.0.0.1)."""
    header = bytearray(34)
    header[0] = 0x0B        # messageType Announce
    header[1] = 0x02        # versionPTP 2
    struct.pack_into(">H", header, 2, 64)
    header[4] = domain
    body = bytearray(30)    # originTimestamp(10) utcOffset(2) reserved(1) priority1(1)
    body[13] = 128          # priority1
    body[14:18] = bytes([248, 0xFE, 0xFF, 0xFF])  # clockQuality
    body[18] = 128          # priority2
    body[19:27] = bytes.fromhex(gm_id.replace("-", ""))
    struct.pack_into(">H", body, 27, steps_removed)
    body[29] = 0xA0         # timeSource
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind((origin, 0))
        s.sendto(bytes(header + body), ("127.0.0.1", 320))
    finally:
        s.close()


def test_grandmaster_address_comes_from_its_announces(fppd, ptp):
    """The grandmaster pmc names is located by the Announce messages that
    carry its identity: the sender's address is reported, a direct
    grandmaster (stepsRemoved 0) wins over a boundary clock relaying it, and
    an Announce for another domain is ignored.

    Feature: 84fb51a8b (grandmaster address and boundary clock)."""
    gm = "AA-BB-CC-FF-FE-DD-EE-FF"
    ptp.answer(port_state="SLAVE", gm_present="true", gm_identity="aabbcc.fffe.ddeeff",
               master_offset=100)
    write_config(fppd)
    start(fppd, ptp)
    fppd.wait_for(lambda: "PTP announce listener thread started" in fppd.log(), timeout=10,
                  what="the Announce listener")
    time.sleep(0.5)
    announce("127.0.0.7", gm, 1, domain=9)
    announce("127.0.0.6", gm, 1)
    st = fppd.wait_for(lambda: (s := ptp_status(fppd))["grandmasterAddress"] and s,
                       timeout=10, what="a grandmaster address")
    assert (st["grandmasterAddress"], st["grandmasterViaBoundary"]) == ("127.0.0.6", True), st
    announce("127.0.0.5", gm, 0)
    st = fppd.wait_for(lambda: (s := ptp_status(fppd))["grandmasterAddress"] == "127.0.0.5" and s,
                       timeout=10, what="the direct grandmaster's address")
    assert st["grandmasterViaBoundary"] is False, st
    announce("127.0.0.6", gm, 1)
    time.sleep(1.5)
    assert ptp_status(fppd)["grandmasterAddress"] == "127.0.0.5", "a boundary clock displaced the grandmaster"


def test_no_lock_warning_comes_down_once_ptp_settles(fppd, ptp):
    """PTP still UNCALIBRATED when the lock wait runs out raises the no-lock
    warning; once pmc reports SLAVE with a small offset, and the clock has
    not stepped since, the watchdog (every 30 s) retracts it and the status
    says the streams are on a locked clock after all.

    Regression: 198bec7bd. Only stopping PTP took this warning down, so on an
    ordinary boot where the grandmaster spoke a few seconds late it stayed up
    until fppd restarted."""
    ptp.answer(port_state="UNCALIBRATED", gm_present="true", master_offset=5000000)
    write_config(fppd, ptpLockWaitMs=1000)
    start(fppd, ptp)
    assert NO_LOCK in warnings(fppd)
    ptp.answer(port_state="SLAVE", gm_present="true", master_offset=200)
    fppd.wait_for(lambda: NO_LOCK not in warnings(fppd), timeout=75, interval=1,
                  what="the no-lock warning to come down")
    assert ptp_status(fppd)["lockedAtStart"] is True
    assert "clearing the provisional-anchor warning" in fppd.log()


def test_ptp_not_installed_warning_comes_down_when_ptp_is_turned_off(fppd):
    """No ptp4l installed and PTP on: "ptp4l not found" is raised. Turning
    PTP off and applying takes it down.

    Regression: 198bec7bd. The four could-not-start warnings had no timeout
    and nothing retracted them, so the banner outlived the config that
    caused it until fppd restarted."""
    if os.path.exists("/usr/sbin/ptp4l"):
        pytest.skip("ptp4l is installed here")
    write_config(fppd)
    start(fppd)
    assert NOT_INSTALLED in warnings(fppd)
    write_config(fppd, ptpEnabled=False)
    apply(fppd)
    assert NOT_INSTALLED not in warnings(fppd)


@pytest.mark.parametrize("how", ["ptp-off", "disabled", "deleted"])
def test_ptp4l_is_stopped_when_an_apply_leaves_nothing_for_it(fppd, ptp, how):
    """PTP on with a send instance starts ptp4l. An "AES67 Apply" of a config
    with PTP turned off, with every instance disabled, or after the
    instances file was deleted stops it, without restarting fppd.

    Regression: 2f8672ecc. ApplyConfig() stopped the pipelines but never
    ptp4l, so unchecking PTP (or removing every stream) left ptp4l running
    -- still a clock on the network -- until fppd was restarted."""
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd)
    start(fppd, ptp)
    fppd.wait_for(ptp.running, timeout=30, what="ptp4l to be started")
    if how == "ptp-off":
        write_config(fppd, ptpEnabled=False)
    elif how == "disabled":
        write_config(fppd, instances=[{"id": 1, "name": "tx", "mode": "send", "enabled": False,
                                       "sapEnabled": False, "multicastIP": "127.0.0.1", "port": 5004}])
    else:
        os.unlink(os.path.join(fppd.media, CONFIG))
    fppd.command("AES67 Apply", timeout=60)
    fppd.wait_for(lambda: not ptp.running(), timeout=15, what="ptp4l to be stopped")


def test_an_apply_keeps_ptp4l_unless_its_settings_change(fppd, ptp):
    """With PTP on and ptp4l running, an "AES67 Apply" of the same config
    leaves the same ptp4l running, as does one that changes only a stream;
    an Apply with a different PTP domain starts a new ptp4l on that domain.

    Regression: 5ad1a2aa4. Every apply stopped ptp4l and started another,
    which takes seconds to rejoin the domain: while it was gone every
    receiver following this box lost its clock -- all of them when it is the
    grandmaster -- for an Apply that touched only the streams, or a watchdog
    rebuild of one stream."""
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd)
    start(fppd, ptp)
    fppd.wait_for(ptp.running, timeout=30, what="ptp4l to be started")
    first = ptp.read("ptp4l.pid").strip()
    apply(fppd)
    assert ptp.read("ptp4l.pid").strip() == first and ptp.running(), "an unchanged apply restarted ptp4l"
    write_config(fppd, instances=[{"id": 1, "name": "tx2", "mode": "send", "enabled": True,
                                   "sapEnabled": False, "multicastIP": "127.0.0.1", "port": 5006}])
    apply(fppd)
    assert ptp.read("ptp4l.pid").strip() == first and ptp.running(), \
        "an apply that changed only a stream restarted ptp4l"
    write_config(fppd, ptpDomain=1)
    apply(fppd)
    fppd.wait_for(lambda: (ptp.read("ptp4l.pid") or "").strip() not in ("", first) and ptp.running(),
                  timeout=30, what="a new ptp4l for the new domain")
    assert ptp.conf().get("domainNumber") == "1", ptp.conf()


def test_stopping_a_ptp4l_that_already_died_signals_nothing(fppd, ptp, tmp_path):
    """ptp4l dies on its own, and an unrelated process is given its PID
    (fppd reaps children at once, so the PID is free for the next one).
    Turning PTP off with an "AES67 Apply" then stops ptp4l: the process now
    on that PID is left running.

    Regression: 1b6dc7564. StopChildProcess() sent SIGTERM, and SIGKILL
    after 3 s, to the PID it had stored without checking what it now
    belonged to, so the stop killed whatever had taken it. ptp4l is now
    signalled through a pidfd, which always means our own child."""
    import shutil
    import signal
    import subprocess
    if not shutil.which("gcc"):
        pytest.skip("gcc is needed to build pid_at.c")
    ptp.keep_name()
    pid_at = str(tmp_path / "pid_at")
    subprocess.run(["gcc", "-O2", "-o", pid_at, os.path.join(os.path.dirname(__file__), "pid_at.c")],
                   check=True)
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd)
    start(fppd, ptp)
    fppd.wait_for(ptp.running, timeout=30, what="ptp4l to be started")
    pid = int(ptp.read("ptp4l.pid"))
    os.kill(pid, signal.SIGKILL)
    deadline = time.monotonic() + 5
    while os.path.exists(f"/proc/{pid}") and time.monotonic() < deadline:
        time.sleep(0.01)
    r = subprocess.run([pid_at, str(pid), "sleep", "301"], capture_output=True, text=True)
    if r.returncode:
        pytest.skip(f"can't place a process on a chosen PID here: {r.stderr.strip()}")
    decoy = int(r.stdout)
    try:
        write_config(fppd, ptpEnabled=False)
        apply(fppd)
        time.sleep(4)  # past the stop's 3 s SIGKILL
        with open(f"/proc/{decoy}/cmdline", "rb") as f:
            alive = f.read().split(b"\0")[:2] == [b"sleep", b"301"]
        assert alive, f"the process given ptp4l's PID {pid} was killed by the stop"
    except FileNotFoundError:
        pytest.fail(f"the process given ptp4l's PID {pid} was killed by the stop")
    finally:
        try:
            os.kill(decoy, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_a_receive_only_box_restarts_a_dead_ptp4l(fppd, ptp):
    """A box with one receive instance and SAP off (so no SAP announcer):
    ptp4l dies, and the watchdog starts a new one within its next pass.

    Regression: a1ee52315. Pipeline recovery, ptp4l supervision and the
    rest of the watchdog ran inside the SAP announcer's loop, which only
    exists with a SAP-announcing sender: on a receive-only box a dead ptp4l
    stayed dead. Not covered: the lead servo's leaked udpsink and clock,
    the other half of the commit."""
    import signal
    ptp.keep_name()
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd, instances=[{"id": 1, "name": "rx", "mode": "receive", "enabled": True,
                                   "sapEnabled": False, "multicastIP": "127.0.0.1", "port": 5004}])
    start(fppd, ptp)
    fppd.wait_for(ptp.running, timeout=30, what="ptp4l to be started")
    first = ptp.read("ptp4l.pid").strip()
    os.kill(int(first), signal.SIGKILL)
    fppd.wait_for(lambda: (ptp.read("ptp4l.pid") or "").strip() not in ("", first) and ptp.running(),
                  timeout=75, interval=1, what="the watchdog to start a new ptp4l")


def test_status_while_ptp4l_starts_and_stops(fppd, ptp):
    """/aes67/status asked for from three clients without pause while
    applies turn PTP on and off six times (each starting or stopping
    ptp4l): every request is answered, and under TSan nothing races.

    Regression: b7ea428a9. Status (and the self-test) read ptp4l's PID and
    pidfd on HTTP threads with no lock while the apply started and stopped
    ptp4l -- closing the pidfd under a reader that could then poll a closed,
    or reused, descriptor. The race shows under TSan; with ASan this only
    checks every request is answered."""
    import threading
    ptp.answer(port_state="LISTENING", gm_present="false")
    write_config(fppd)
    start(fppd, ptp)
    stop = threading.Event()
    errors = []

    def poll():
        while not stop.is_set():
            try:
                fppd.get("/aes67/status")
            except Exception as e:
                errors.append(repr(e))
                return
    threads = [threading.Thread(target=poll) for _ in range(3)]
    for t in threads:
        t.start()
    try:
        for i in range(6):
            write_config(fppd, ptpEnabled=i % 2 == 1)
            apply(fppd)
    finally:
        stop.set()
        for t in threads:
            t.join(30)
    assert not errors, errors
