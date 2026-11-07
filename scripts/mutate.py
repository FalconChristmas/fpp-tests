#!/usr/bin/env python3
"""How well do scenarios check a source file? Runs hand-written mutants of it.

    scripts/mutate.py TREE FILE MUTANTS WORKDIR [-j N] -- PYTEST-ARGS...

TREE is an exported fpp tree (built here if it has no src/fppd), FILE a path in
it, MUTANTS a file of JSON lines: [line, "old text", "new text"], where the old
text must appear exactly once on that line, so a list gone stale fails at once
rather than mutating the wrong thing. PYTEST-ARGS name the scenarios, relative
to this checkout; check they pass on the unmutated tree first, and --deselect
any that don't, or every mutant reads as killed.

Each mutant is built in a copy of TREE under WORKDIR and run until a test fails.
That test then runs again alone: if it passes, it is flaky, not a kill, and the
run goes on without it. Results go to WORKDIR/results.jsonl, one per mutant, with
status killed, survived, timeout, build-failed or no-result; mutants already
there are skipped, so a run can be resumed.
"""

import argparse
import json
import os
import queue
import shlex
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = "fpp-tests-env"
OFFLINE = ["--add-host=" + h + ":127.0.0.1" for h in (
    "fppstats.falconchristmas.com", "crashes.falconplayer.com", "github.com", "www.github.com",
    "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com")]
MAKE = "cd /work/mut/src && make -j6 DISTRIBUTED_COMPILE=1 asan BUILD_FPPCAPEDETECT=1 BUILD_FPPRTC=1 > /artifacts/build.log 2>&1"


def scenario(tree, artifacts, script, timeout):
    """Runs script in a scenario container on its own network: (exit code, output)."""
    net = f"fpp-tests-mutate-{os.getpid()}-{threading.get_ident()}-{time.time_ns()}"
    subprocess.run(["docker", "network", "create", "--label", "fpp-tests", net], capture_output=True)
    fd, media_root = tempfile.mkstemp(dir=artifacts, prefix="media-root.")
    os.close(fd)
    cmd = ["docker", "run", "--rm", "--name", net, "--ulimit", "nofile=1048576:1048576", "--network", net, *OFFLINE,
           "-v", f"{tree}:/work/mut", "-v", f"{HERE}:/tests:ro", "-v", f"{artifacts}:/artifacts",
           "-v", f"{media_root}:/work/mut/www/media_root.txt",
           "-e", "FPP_TREE=/work/mut", "-e", "FPP_FLAVOR=asan", "-e", "FPP_TESTS_ARTIFACTS=/artifacts",
           "--cap-add", "SYS_PTRACE", "--cap-add", "SYS_NICE", "--cap-add", "NET_ADMIN", "--cap-add", "SYS_ADMIN",
           "--security-opt", "apparmor=unconfined", "--tmpfs", "/tmp:rw,exec,nosuid,size=4g",
           IMAGE, "sh", "-c", script]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        rc, out = r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "rm", "-f", net], capture_output=True)
        rc, out = 124, ""
    subprocess.run(["docker", "network", "rm", net], capture_output=True)
    os.unlink(media_root)
    return rc, out


def pytest(tree, artifacts, args, timeout):
    """(exit code, output, {failed test id: message})."""
    junit = os.path.join(artifacts, "junit.xml")
    if os.path.exists(junit):
        os.unlink(junit)
    quoted = " ".join(shlex.quote(a) for a in args)
    rc, out = scenario(tree, artifacts, f"{MAKE} || exit 10; cd /tests; python3 -m pytest -p no:cacheprovider -q "
                                        f"--junitxml=/artifacts/junit.xml {quoted} 2>&1 | tail -3", timeout)
    failed = {}
    if os.path.exists(junit):
        for t in ET.parse(junit).getroot().iter("testcase"):
            bad = t.find("failure") if t.find("failure") is not None else t.find("error")
            if bad is not None:
                node = "scenarios/" + t.get("classname", "").split(".")[-1] + ".py::" + t.get("name", "")
                failed[node] = (bad.get("message") or "")[:500]
    return rc, out, failed


def run_mutant(tree, artifacts, args, timeout):
    flaky = []
    while True:
        skip = [a for node in flaky for a in ("--deselect", node)]
        rc, out, failed = pytest(tree, artifacts, ["-x", *skip, *args], timeout)
        if rc == 10:
            return {"status": "build-failed"}
        if rc == 124:
            return {"status": "timeout", "flaky": flaky}
        if not failed:
            ok = " passed" in out and " failed" not in out and " error" not in out
            return {"status": "survived" if ok else "no-result", "flaky": flaky, "output": "" if ok else out[-500:]}
        node, message = next(iter(failed.items()))
        if pytest(tree, artifacts, [node], timeout)[2]:
            return {"status": "killed", "by": node, "message": message, "flaky": flaky}
        flaky.append(node)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("tree")
    p.add_argument("file")
    p.add_argument("mutants")
    p.add_argument("workdir")
    p.add_argument("-j", type=int, default=1)
    p.add_argument("--timeout", type=int, default=3000, help="seconds for one pytest run")
    p.add_argument("pytest", nargs="+")
    o = p.parse_args()

    tree, workdir = os.path.abspath(o.tree), os.path.abspath(o.workdir)
    os.makedirs(workdir, exist_ok=True)
    with open(o.mutants) as f:
        mutants = [json.loads(line) for line in f if line.strip()]
    with open(os.path.join(tree, o.file), errors="surrogateescape") as f:
        source = f.read().split("\n")
    for line, old, _ in mutants:
        if source[line - 1].count(old) != 1:
            p.error(f"line {line} does not hold {old!r} exactly once: {source[line - 1].strip()!r}")

    if not os.path.exists(os.path.join(tree, "src", "fppd")):
        subprocess.check_call(["docker", "run", "--rm", "--ulimit", "nofile=1048576:1048576", "-v", f"{tree}:/work/mut",
                               "-v", "fpp-tests-ccache:/ccache", "-v", f"{HERE}:/tests:ro", IMAGE, "sh", "-c",
                               "/tests/scripts/build-fpp.sh /work/mut asan && chmod -R a+rwX /work/mut"])

    results = os.path.join(workdir, "results.jsonl")
    done = set()
    if os.path.exists(results):
        with open(results) as f:
            done = {json.loads(line)["id"] for line in f}
    todo = queue.Queue()
    for i in range(len(mutants)):
        if i not in done:
            todo.put(i)
    lock = threading.Lock()

    def worker(n):
        copy, artifacts = os.path.join(workdir, f"tree{n}"), os.path.join(workdir, f"artifacts{n}")
        if not os.path.exists(copy):
            subprocess.check_call(["cp", "-a", tree, copy])
        os.makedirs(artifacts, exist_ok=True)
        while True:
            try:
                i = todo.get_nowait()
            except queue.Empty:
                return
            line, old, new = mutants[i]
            lines = list(source)
            lines[line - 1] = lines[line - 1].replace(old, new)
            with open(os.path.join(copy, o.file), "w", errors="surrogateescape") as f:
                f.write("\n".join(lines))
            result = {"id": i, "line": line, "old": old, "new": new,
                      **run_mutant(copy, artifacts, o.pytest, o.timeout)}
            with lock, open(results, "a") as f:
                f.write(json.dumps(result) + "\n")
            print(i, line, result["status"], result.get("by", ""), flush=True)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(o.j)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
