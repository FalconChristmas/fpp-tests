"""Freezes the device's PipeWire on request, for run-local.sh --host-audio.

The scenarios run in their own PID namespace, where the device's PipeWire
daemon has no PID, so a scenario that stalls the audio graph asks this
helper, which run-local.sh starts outside the namespace. Each line written to
<dir>/fifo is a stall in ms: the oldest pipewire process is stopped for that
long, then continued; the helper answers with a line in <dir>/done.

    python3 pipewire-stall.py <dir> <pid to outlive>

It exits, removing <dir>, once the run (the pid given) is gone.
"""

import os
import shutil
import signal
import subprocess
import sys
import threading
import time


def pipewire_pid():
    out = subprocess.run(["pgrep", "-x", "-o", "pipewire"], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None


def main():
    d, watch = sys.argv[1], int(sys.argv[2])
    fifo = os.path.join(d, "fifo")

    def watcher():
        while True:
            try:
                os.kill(watch, 0)
            except ProcessLookupError:
                shutil.rmtree(d, ignore_errors=True)
                os._exit(0)
            time.sleep(1)

    threading.Thread(target=watcher, daemon=True).start()
    while True:
        with open(fifo) as f:
            for line in f:
                ms = int(line.strip() or 0)
                pid = pipewire_pid()
                if pid:
                    os.kill(pid, signal.SIGSTOP)
                    try:
                        time.sleep(ms / 1000)
                    finally:
                        os.kill(pid, signal.SIGCONT)
                with open(os.path.join(d, "done"), "a") as out:
                    out.write(f"{pid or 0} {ms}\n")


if __name__ == "__main__":
    main()
