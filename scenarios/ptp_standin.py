"""Stand-ins for linuxptp (ptp4l, pmc, phc2sys), for the AES67 PTP scenarios.

AES67Manager probes /usr/sbin/ptp4l by absolute path, runs "ptp4l" from PATH,
asks /usr/sbin/pmc (absolute) for the port state and the grandmaster, and used
to start phc2sys when /dev/ptp0 and /usr/sbin/phc2sys existed. The test
container has no linuxptp, so these are made there for the scenario and
removed after it; a scenario using them skips anywhere else, where they would
replace a real install.

Each stand-in reads and writes files in one directory (`dir`), which fppd's
environment names in FPP_TESTS_PTP_DIR:

  ptp4l    with no -i it is the option probe: it prints ptp4l's "unknown
           option" message for a key listed in `unknown-options`, else "no
           interface specified". With -i it is the daemon: it saves its argv
           (ptp4l.argv, one per line), the config it was given (ptp4l.conf)
           and its pid (ptp4l.pid), and stays up.
  pmc      prints the file named after the TLV it is asked for
           (TIME_STATUS_NP, PORT_DATA_SET), or nothing; its argv goes to
           pmc.argv.
  phc2sys  saves its argv to phc2sys.argv and stays up.
"""

import os
import shutil

import pytest

PTP4L = """#!/bin/sh
d="$FPP_TESTS_PTP_DIR"
iface=""
conf=""
prev=""
for a in "$@"; do
    [ "$prev" = "-i" ] && iface="$a"
    [ "$prev" = "-f" ] && conf="$a"
    prev="$a"
done
case " $* " in
*" -i "*)
    printf '%s\\n' "$@" > "$d/ptp4l.argv"
    cp "$conf" "$d/ptp4l.conf.new" && mv "$d/ptp4l.conf.new" "$d/ptp4l.conf"
    echo $$ > "$d/ptp4l.pid"
    exec sleep 1000 ;;
esac
key=$(sed -n 2p "$conf" | cut -f1)
if [ -n "$key" ] && grep -qx "$key" "$d/unknown-options" 2>/dev/null; then
    echo "unknown option $key at line 2 in global section"
    exit 254
fi
echo "no interface specified"
exit 255
"""

PMC = """#!/bin/sh
d="$FPP_TESTS_PTP_DIR"
printf '%s\\n' "$@" > "$d/pmc.argv"
for a in "$@"; do last="$a"; done
tlv=${last#GET }
echo "sending: GET $tlv"
[ -f "$d/$tlv" ] && cat "$d/$tlv"
exit 0
"""

PHC2SYS = """#!/bin/sh
printf '%s\\n' "$@" > "$FPP_TESTS_PTP_DIR/phc2sys.argv"
exec sleep 1000
"""


def time_status(gm_present=None, gm_identity="001122.fffe.334455", master_offset=None):
    """pmc's TIME_STATUS_NP answer. A field passed as None is left out."""
    lines = ["\t001122.fffe.334455-0 seq 0 RESPONSE MANAGEMENT TIME_STATUS_NP "]
    if master_offset is not None:
        lines.append(f"\t\tmaster_offset              {master_offset}")
    lines += ["\t\tingress_time               0",
              "\t\tcumulativeScaledRateOffset +0.000000000",
              "\t\tgmTimeBaseIndicator        0"]
    if gm_present is not None:
        lines.append(f"\t\tgmPresent                  {gm_present}")
    if gm_identity is not None:
        lines.append(f"\t\tgmIdentity                 {gm_identity}")
    return "\n".join(lines) + "\n"


def port_data_set(state):
    return ("\t001122.fffe.334455-1 seq 1 RESPONSE MANAGEMENT PORT_DATA_SET \n"
            "\t\tportIdentity            001122.fffe.334455-1\n"
            f"\t\tportState               {state}\n"
            "\t\tlogMinDelayReqInterval  0\n"
            "\t\tpeerMeanPathDelay       0\n")


class Ptp:
    def __init__(self, fppd):
        self.dir = os.path.join(fppd.media, "tmp", "ptp")
        os.makedirs(self.dir)
        self.made = []

    def install(self, name, script):
        path = "/usr/sbin/" + name
        if os.path.exists(path):
            raise RuntimeError(f"{path} is already there")
        with open(path, "w") as f:
            f.write(script)
        os.chmod(path, 0o755)
        self.made.append(path)

    def touch(self, path):
        open(path, "w").close()
        self.made.append(path)

    def env(self):
        return {"FPP_TESTS_PTP_DIR": self.dir}

    def answer(self, port_state=None, **time_status_fields):
        """Set what pmc reports from now on: the port state and the
        TIME_STATUS_NP fields (see time_status())."""
        if port_state is not None:
            self._put("PORT_DATA_SET", port_data_set(port_state))
        self._put("TIME_STATUS_NP", time_status(**time_status_fields))

    def unknown_option(self, key):
        """Make the ptp4l probe reject a config key, as an older linuxptp does."""
        with open(os.path.join(self.dir, "unknown-options"), "a") as f:
            f.write(key + "\n")

    def _put(self, name, text):
        tmp = os.path.join(self.dir, name + ".new")
        with open(tmp, "w") as f:
            f.write(text)
        os.replace(tmp, os.path.join(self.dir, name))

    def read(self, name):
        try:
            with open(os.path.join(self.dir, name)) as f:
                return f.read()
        except FileNotFoundError:
            return None

    def conf(self):
        """The ptp4l config fppd started the stand-in with, as {key: value}."""
        text = self.read("ptp4l.conf") or ""
        out = {}
        for line in text.splitlines():
            parts = line.split()
            if len(parts) >= 2 and not line.startswith(("#", "[")):
                out[parts[0]] = parts[1]
        return out

    def running(self):
        """Whether the last ptp4l daemon started is still running."""
        pid = (self.read("ptp4l.pid") or "").strip()
        if not pid:
            return False
        try:
            with open(f"/proc/{pid}/stat") as f:
                return f.read().rsplit(")", 1)[1].split()[0] != "Z"
        except FileNotFoundError:
            return False

    def argv(self, name="ptp4l"):
        text = self.read(name + ".argv")
        return None if text is None else text.splitlines()

    def cleanup(self):
        for path in reversed(self.made):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def ptp_standins(fppd, ptp4l=True, pmc=True, phc2sys=False):
    """Install the stand-ins (see the module docstring); a Ptp to drive them.
    The caller must call cleanup(). Skips outside the test container, and
    where any of them is installed already."""
    if not os.path.exists("/etc/fpp/container"):
        pytest.skip("replaces /usr/sbin/ptp4l and pmc: only inside the test container")
    for name, want in (("ptp4l", ptp4l), ("pmc", pmc), ("phc2sys", phc2sys)):
        if want and (os.path.exists("/usr/sbin/" + name) or shutil.which(name)):
            pytest.skip(f"{name} is installed here")
    p = Ptp(fppd)
    try:
        if ptp4l:
            p.install("ptp4l", PTP4L)
        if pmc:
            p.install("pmc", PMC)
        if phc2sys:
            p.install("phc2sys", PHC2SYS)
    except Exception:
        p.cleanup()
        raise
    return p
