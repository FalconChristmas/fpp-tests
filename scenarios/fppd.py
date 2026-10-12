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
        self.proc = None

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

    def start(self, timeout=60):
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
        env["TSAN_OPTIONS"] = f"halt_on_error=0:log_path={self.media}/logs/tsan"
        self.out = open(os.path.join(self.media, "logs", "fppd.stdout"), "w")
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

    def cleanup(self):
        try:
            if self.proc is not None and self.proc.poll() is None:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait()
        finally:
            if self.proc is not None:
                self.out.close()
            if not os.environ.get("FPP_TESTS_KEEP"):
                shutil.rmtree(self.media, ignore_errors=True)

    # --- reports ---------------------------------------------------------

    def sanitizer_reports(self):
        logs = os.path.join(self.media, "logs")
        found = []
        for name in sorted(os.listdir(logs)):
            if name.startswith(("asan.", "tsan.")):
                with open(os.path.join(logs, name), errors="replace") as f:
                    found.append(f.read())
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


def describe_rc(rc):
    if rc < 0:
        try:
            return f"signal {signal.Signals(-rc).name}"
        except ValueError:
            return f"signal {-rc}"
    return f"status {rc}"
