"""fppd on macOS, for the scenarios that only a macOS build has
(test_macos_fppd.py).

macOS has no namespaces, so the test fppd runs on the Mac itself, with:
  - a scratch media directory (the tree's www/media_root.txt points at it
    for the run, and is put back after);
  - netguard_mac.dylib (DYLD_INSERT_LIBRARIES), which refuses every send and
    connect past the loopback interface, Bonjour and name lookups, and logs
    each refusal: nothing it does reaches the LAN;
  - its API on 127.0.0.1:32322, which another fppd on the Mac must not hold
    (the scenarios skip if one answers there).

FPP_TREE is a macOS build of fpp (make in src/). Run with a pytest on the
Mac, e.g. FPP_TREE=<tree> python3 -m pytest scenarios/test_macos_fppd.py.
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
API = "http://127.0.0.1:32322"


def dylib(source, *flags):
    """scenarios/<source> built as a dylib, once per version of the source."""
    import hashlib
    src = os.path.join(HERE, source)
    with open(src, "rb") as f:
        tag = hashlib.sha1(f.read()).hexdigest()[:12]
    lib = os.path.join(tempfile.gettempdir(), f"{os.path.splitext(source)[0]}-{tag}.dylib")
    if not os.path.exists(lib):
        subprocess.run(["clang", "-dynamiclib", "-O2", "-o", lib, src, *flags], check=True)
    return lib


def guard():
    return dylib("netguard_mac.c")


def api_up():
    try:
        with socket.create_connection(("127.0.0.1", 32322), timeout=1):
            return True
    except OSError:
        return False


class MacFppd:
    def __init__(self, tree):
        self.tree = os.path.realpath(tree)
        self.dir = tempfile.mkdtemp(prefix="macfppd-", dir="/tmp")
        self.media = os.path.join(self.dir, "media")
        for d in ("config", "logs", "tmp", "music", "sequences", "playlists", "plugins", "scripts",
                  "upload", "videos", "images", "effects", "plugindata"):
            os.makedirs(os.path.join(self.media, d))
        # Nothing to go out on: MultiSync off, and no channel outputs at all.
        # The WLED API responder is off too: before 657efd007 fppd could not
        # stop on macOS with it on, and the other scenarios' controls run
        # older trees. The one that checks the responder turns it back on.
        self.settings(MultiSyncEnabled="0", MultiSyncBroadcast="0", DisableFakeNetworkBridges="1",
                      WLEDAPIResponder="0")
        self.root_txt = os.path.join(self.tree, "www", "media_root.txt")
        self.old_root = open(self.root_txt).read() if os.path.exists(self.root_txt) else None
        with open(self.root_txt, "w") as f:
            f.write(self.media)
        self.guard_log = os.path.join(self.dir, "netguard.log")
        self.proc = None
        self.out = os.path.join(self.dir, "fppd.out")

    def settings(self, **kv):
        with open(os.path.join(self.media, "settings"), "a") as f:
            for k, v in kv.items():
                f.write(f'{k} = "{v}"\n')

    def write(self, rel, content):
        path = os.path.join(self.media, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(json.dumps(content) if isinstance(content, (dict, list)) else content)

    def start(self, timeout=60, extra_env=None, preload=()):
        env = dict(os.environ, HOME=self.dir, NETGUARD_LOG=self.guard_log,
                   DYLD_INSERT_LIBRARIES=":".join([guard(), *preload]))
        env.update(extra_env or {})
        self.proc = subprocess.Popen([os.path.join(self.tree, "src", "fppd"), "-f", "-l",
                                      os.path.join(self.media, "logs", "fppd.log")],
                                     cwd=os.path.join(self.tree, "src"), env=env,
                                     stdout=open(self.out, "w"), stderr=subprocess.STDOUT,
                                     start_new_session=True)
        deadline = time.monotonic() + timeout
        while not self.status():
            assert self.proc.poll() is None, f"fppd exited {self.proc.returncode} at startup:\n{self.output()}"
            assert time.monotonic() < deadline, f"fppd's API never answered:\n{self.output()}"
            time.sleep(0.25)

    def request(self, method, path, body=None, timeout=10):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        req = urllib.request.Request(API + path, data=data, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()

    def status(self):
        try:
            return json.loads(self.request("GET", "/fppd/status", timeout=2))
        except Exception:
            return None

    def stop(self, timeout=60):
        """SIGTERM fppd; its exit status."""
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait()
                return "hung"
        return self.proc.returncode

    def output(self):
        try:
            with open(self.out, errors="replace") as f:
                return f.read()[-4000:]
        except OSError:
            return ""

    def refused(self):
        """What netguard refused, one "<call> <destination>" each."""
        try:
            with open(self.guard_log) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def off_box(self):
        """fppd's sockets that are connected to anything but loopback (lsof)."""
        if not self.proc or self.proc.poll() is not None:
            return []
        out = subprocess.run(["lsof", "-nP", "-a", "-p", str(self.proc.pid), "-i"],
                             capture_output=True, text=True).stdout
        return [l for l in out.splitlines()[1:] if "->" in l and "->127." not in l and "->[::1]" not in l]

    def close(self):
        self.stop()
        if self.old_root is None:
            os.unlink(self.root_txt)
        else:
            with open(self.root_txt, "w") as f:
                f.write(self.old_root)


@pytest.fixture
def macfppd():
    import sys
    if sys.platform != "darwin":
        pytest.skip("macOS only")
    tree = os.environ.get("FPP_TREE", "")
    if not os.path.exists(os.path.join(tree, "src", "fppd")):
        pytest.skip("FPP_TREE is not a built fpp tree")
    if api_up():
        pytest.skip("another fppd answers on 127.0.0.1:32322 here")
    f = MacFppd(tree)
    try:
        yield f
        assert not f.off_box(), f"fppd has connections off the loopback: {f.off_box()}"
    finally:
        f.close()
        shutil.rmtree(f.dir, ignore_errors=True)
