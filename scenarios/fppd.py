"""Start, drive and stop one fppd for a scenario.

Each scenario gets its own empty media directory and its own fppd process, so
a crash or wedge in one cannot leak into the next. fppd finds its media
directory through www/media_root.txt in the tree it was built in, which this
rewrites before every start.
"""

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:32322"

MEDIA_DIRS = [
    "config", "effects", "images", "logs", "music", "playlists", "plugindata",
    "plugins", "scripts", "sequences", "tmp", "upload", "videos",
    "virtualdisplay_assets",
]


class FppdDied(AssertionError):
    pass


class Fppd:
    def __init__(self, tree):
        self.tree = tree
        self.media = tempfile.mkdtemp(prefix="media-")
        for d in MEDIA_DIRS:
            os.makedirs(os.path.join(self.media, d))
        # A crash report would run scripts/generate_crash_report, which
        # works in the hard-coded /home/fpp/media -- the device's own media
        # when run-local.sh tests on an FPP device. The sanitizer report and
        # the saved artifacts cover what the crash report would.
        self.settings(ShareCrashData="-1")
        self.proc = None
        # Set by a scenario that makes fppd exit on purpose and has checked
        # how it exited; the fixture then skips its own end-of-test checks.
        self.exit_expected = False

    # --- setup, before start() -------------------------------------------

    def write(self, rel, content):
        """Write a file under the media directory (str, bytes or JSON-able)."""
        path = os.path.join(self.media, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not isinstance(content, (str, bytes)):
            content = json.dumps(content, indent=4)
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(path, mode) as f:
            f.write(content)
        return path

    def settings(self, **kv):
        """Append key = "value" lines to the media settings file."""
        with open(os.path.join(self.media, "settings"), "a") as f:
            for k, v in kv.items():
                f.write(f'{k} = "{v}"\n')

    # --- lifecycle -------------------------------------------------------

    def start(self, timeout=60, fake_time=None, tz=None):
        """Start fppd and wait until its API answers.

        fake_time: "YYYY-MM-DD HH:MM:SS" -- fppd's wall clock starts there
                   and runs on in real time (libfaketime; the monotonic
                   clock is left alone, so timers behave).
        tz:        a zone name such as "America/New_York" for fppd's TZ.
        """
        with open(os.path.join(self.tree, "www", "media_root.txt"), "w") as f:
            f.write(self.media)
        env = dict(os.environ)
        # fppd refuses to start an ASan build without its own directory here.
        src = os.path.join(self.tree, "src")
        env["LD_LIBRARY_PATH"] = src + ":" + env.get("LD_LIBRARY_PATH", "")
        # halt on the first report so the test sees the process die there;
        # leak checking is off because fppd's shutdown is not leak-clean.
        env["ASAN_OPTIONS"] = (
            "halt_on_error=1:detect_leaks=0:abort_on_error=0:"
            f"log_path={self.media}/logs/asan"
        )
        # Known races are listed (and explained) in sanitizers/tsan.supp;
        # anything else is a report, and fails the scenario.
        supp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sanitizers", "tsan.supp")
        env["TSAN_OPTIONS"] = (f"halt_on_error=0:log_path={self.media}/logs/tsan:"
                               f"suppressions={os.path.normpath(supp)}")
        if tz:
            env["TZ"] = tz
        if fake_time:
            env.update(faketime_env(os.path.join(src, "fppd"), fake_time))
            # Read from a file on every call, so set_clock() can step it.
            self.clock_file = os.path.join(self.media, "tmp", "faketime")
            with open(self.clock_file, "w") as f:
                f.write(env.pop("FAKETIME") + "\n")
            env["FAKETIME_TIMESTAMP_FILE"] = self.clock_file
            # The sanitizer allocators read the clock (via libfaketime) for
            # their release-to-OS bookkeeping, and libfaketime's one-time
            # setup allocates (dlvsym): the clock read waits on the setup that
            # is allocating, and fppd hangs before it prints anything. Turning
            # the release off removes the allocator's clock read. TSan on
            # arm64 happened not to read it; on x86_64 it does.
            env["ASAN_OPTIONS"] += ":allocator_release_to_os_interval_ms=-1"
            env["TSAN_OPTIONS"] += ":allocator_release_to_os_interval_ms=-1"
        self.out = open(os.path.join(self.media, "logs", "fppd.stdout"), "w")
        self.started = time.monotonic()
        self.proc = subprocess.Popen(
            [os.path.join(self.tree, "src", "fppd"), "-f"],
            cwd=os.path.join(self.tree, "src"),
            stdout=self.out, stderr=subprocess.STDOUT, env=env,
            start_new_session=True,
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.check_alive()
            try:
                status = self.get("/fppd/status", timeout=2)
                if status.get("fppd") == "running" or "status_name" in status:
                    return status
            except (urllib.error.URLError, ConnectionError, TimeoutError, ValueError):
                pass
            time.sleep(0.25)
        raise TimeoutError(f"fppd did not answer /fppd/status within {timeout}s\n{self.tail()}")

    def set_clock(self, when):
        """Step fppd's faked wall clock (started with fake_time=) so that it
        reads about `when` ("YYYY-MM-DD HH:MM:SS") now. libfaketime counts
        from the process's start, so the elapsed run time is subtracted."""
        import datetime
        target = datetime.datetime.strptime(when, "%Y-%m-%d %H:%M:%S")
        base = target - datetime.timedelta(seconds=time.monotonic() - self.started)
        # Replaced in one rename, never rewritten in place: libfaketime reads
        # the file on every clock call, and a half-written one makes it call
        # exit() from inside gettimeofday(), whose exit handlers then deadlock
        # on libfaketime's own lock.
        tmp = self.clock_file + ".new"
        with open(tmp, "w") as f:
            f.write("@" + base.strftime("%Y-%m-%d %H:%M:%S") + "\n")
        os.replace(tmp, self.clock_file)

    def check_alive(self):
        if self.proc is None:
            return
        rc = self.proc.poll()
        if rc is not None:
            raise FppdDied(f"fppd exited with {describe_rc(rc)}\n{self.tail()}")

    def stop(self, timeout=30):
        """Stop fppd and return its exit code. Never leaves it running."""
        if self.proc is None or self.proc.poll() is not None:
            return None if self.proc is None else self.proc.returncode
        self.proc.send_signal(signal.SIGTERM)
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()
            raise TimeoutError(f"fppd did not exit within {timeout}s of SIGTERM")

    def backtrace(self):
        """Save every thread's stack of a still-running fppd to
        logs/backtrace.txt -- for a wedge, this is the answer."""
        if self.proc is None or self.proc.poll() is not None:
            return None
        path = os.path.join(self.media, "logs", "backtrace.txt")
        with open(path, "w") as f:
            subprocess.run(
                ["gdb", "-p", str(self.proc.pid), "-batch", "-nx",
                 "-ex", "set pagination off", "-ex", "thread apply all bt"],
                stdout=f, stderr=subprocess.STDOUT, timeout=120,
            )
        return path

    def kill(self):
        if self.proc is not None and self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()

    def cleanup(self):
        try:
            self.kill()
        finally:
            if self.proc is not None:
                self.out.close()
            if not os.environ.get("FPP_TESTS_KEEP"):
                shutil.rmtree(self.media, ignore_errors=True)

    # --- reports ---------------------------------------------------------

    def sanitizer_reports(self):
        """fppd's own sanitizer reports. Each process writes <tool>.<pid>;
        fppd's children (scripts, system tools) inherit the preloaded runtime
        but are not built with it, and under libfaketime TSan's allocator
        aborts inside them, so only fppd's pid counts."""
        logs = os.path.join(self.media, "logs")
        found = []
        pid = str(self.proc.pid) if self.proc is not None else None
        for name in sorted(os.listdir(logs)):
            if name in (f"asan.{pid}", f"tsan.{pid}"):
                with open(os.path.join(logs, name), errors="replace") as f:
                    text = f.read()
                # TSan's deadlock detector prints this, and nothing else, when
                # a chain of nested locks is longer than it tracks (a playlist
                # inserting itself ten deep). It is not a report.
                if text.strip() == "WARNING: too long mutex cycle found":
                    continue
                found.append(text)
        return found

    def log(self):
        path = os.path.join(self.media, "logs", "fppd.log")
        if not os.path.exists(path):
            return ""
        with open(path, errors="replace") as f:
            return f.read()

    def tail(self, n=40):
        out = []
        for name in ("fppd.stdout", "fppd.log"):
            path = os.path.join(self.media, "logs", name)
            if os.path.exists(path):
                with open(path, errors="replace") as f:
                    lines = f.read().splitlines()[-n:]
                out.append(f"--- last {len(lines)} lines of {name}:\n" + "\n".join(lines))
        for r in self.sanitizer_reports():
            out.append("--- sanitizer report:\n" + r[:8000])
        return "\n".join(out)

    # --- HTTP ------------------------------------------------------------

    def request(self, method, path, body=None, timeout=10):
        """Call fppd's own HTTP server. A timeout here means fppd is wedged."""
        data = None
        headers = {}
        if body is not None:
            if isinstance(body, (dict, list)):
                data = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
            elif isinstance(body, str):
                data = body.encode()
            else:
                data = body
        req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read().decode(errors="replace")
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            e.body = text
            raise
        except (TimeoutError, urllib.error.URLError) as e:
            self.check_alive()
            if isinstance(e, TimeoutError) or "timed out" in str(e):
                raise TimeoutError(f"{method} {path} got no answer within {timeout}s: fppd is wedged") from e
            raise
        try:
            return json.loads(text)
        except ValueError:
            return text

    def get(self, path, timeout=10):
        return self.request("GET", path, timeout=timeout)

    def post(self, path, body=None, timeout=10):
        return self.request("POST", path, body, timeout=timeout)

    def command(self, name, *args, timeout=10):
        return self.post("/command", {"command": name, "args": [str(a) for a in args]}, timeout=timeout)

    def wait_for(self, predicate, timeout=10, interval=0.1, what="condition"):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            self.check_alive()
            last = predicate()
            if last:
                return last
            time.sleep(interval)
        raise TimeoutError(f"timed out after {timeout}s waiting for {what} (last: {last!r})")


def faketime_env(binary, when):
    """Environment that starts `binary`'s wall clock at `when`."""
    import glob
    import pytest
    libs = glob.glob("/usr/lib/*/faketime/libfaketimeMT.so.1")
    if not libs:
        pytest.skip("libfaketime is not installed (apt-get install faketime)")
    preload = [libs[0]]
    # A sanitizer runtime has to come first in the preload list.
    ldd = subprocess.run(["ldd", binary], capture_output=True, text=True).stdout
    for line in ldd.splitlines():
        if any(n in line for n in ("libasan.so", "libtsan.so")) and "=>" in line:
            preload.insert(0, line.split("=>")[1].split()[0])
    return {
        "LD_PRELOAD": " ".join(preload),
        "FAKETIME": "@" + when,
        "FAKETIME_DONT_FAKE_MONOTONIC": "1",
        "FAKETIME_NO_CACHE": "1",
        # File times stay real. libfaketime's stat() interceptor can deadlock
        # at startup (drogon's createPath -> std::filesystem::status), and no
        # scenario needs faked file times.
        "NO_FAKE_STAT": "1",
        # fppd's child processes (scripts, gdb) see the real clock.
        "FAKETIME_SKIP_CMDS": "gdb,sh,bash",
    }


def sanitizer(tree=None):
    """"asan", "tsan", "ubsan" or None: the runtime the fppd under test was
    built with, read from what libfpp links."""
    tree = tree or os.environ.get("FPP_TREE", "")
    out = subprocess.run(["ldd", os.path.join(tree, "src", "libfpp.so")],
                         capture_output=True, text=True).stdout
    for name in ("asan", "tsan", "ubsan"):
        if f"lib{name}.so" in out:
            return name
    return None


def describe_rc(rc):
    if rc < 0:
        try:
            return f"signal {signal.Signals(-rc).name}"
        except ValueError:
            return f"signal {-rc}"
    return f"status {rc}"
