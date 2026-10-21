"""PID 1 of run-local.sh's PID namespace: runs the command given, reaps
every process orphaned into the namespace while it runs, and exits with the
command's status when it exits.

When PID 1 of a PID namespace exits, the kernel kills everything left in
it, so nothing a run started -- a test fppd, a child fppd forked, an
fppoled a scenario ran -- outlives the run, however the run ended: pytest
finishing, a test that forgot a child, pytest killed by a lost ssh session
or a timeout. Whatever is left is named on stderr before it goes.

    python3 ns-init.py <command> [args...]
"""

import os
import signal
import sys
import time


def leftovers():
    out = []
    for d in os.listdir("/proc"):
        if not d.isdigit() or d == "1":
            continue
        try:
            with open(f"/proc/{d}/comm") as f:
                out.append(f"{f.read().strip()} ({d})")
        except OSError:
            pass
    return out


def main():
    child = os.fork()
    if child == 0:
        try:
            os.execvp(sys.argv[1], sys.argv[1:])
        finally:
            os._exit(127)

    def forward(sig, _frame):
        try:
            os.kill(child, sig)
        except ProcessLookupError:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
        signal.signal(sig, forward)

    rc = 1
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except ChildProcessError:
            break
        if pid == child:
            rc = os.waitstatus_to_exitcode(status)
            rc = rc if rc >= 0 else 128 - rc
            break

    left = leftovers()
    if left:
        print("run-local.sh: stopping what the run left running: " + ", ".join(left),
              file=sys.stderr, flush=True)
        for d in os.listdir("/proc"):
            if d.isdigit() and d != "1":
                try:
                    os.kill(int(d), signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                while os.waitpid(-1, os.WNOHANG)[0]:
                    pass
            except ChildProcessError:
                break
            time.sleep(0.05)
    # Exiting kills whatever is still here.
    sys.exit(rc)


if __name__ == "__main__":
    main()
