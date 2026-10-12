#!/bin/sh
# Run the scenario suite against an fpp tree as it is built right now --
# normally /opt/fpp on an FPP device, uncommitted changes and all. Nothing is
# exported or built: run `make` (or `make debug`, `make tsan`) in the tree
# first, then this.
#
#   ./run-local.sh [--fpp DIR] [pytest args...]
#
# --fpp   the fpp tree whose src/fppd to test (default /opt/fpp)
#
# The device's own fppd keeps running. Each test fppd runs in private mount
# and network namespaces, set up below, so that it cannot reach the device's
# show, network or files:
#   - a loopback-only network: no port clashes, nothing onto the show network;
#   - its own /tmp, /run and /dev/shm (command socket, PipeWire, D-Bus, mDNS);
#   - an overlay over the tree: fppd reads the real tree, but everything it
#     writes there (media_root.txt, www/warnings*.json) lands in a scratch
#     layer, so the device's fppd and web UI never see it;
#   - no sound cards, SPI devices as /dev/null (fppd probes SPI0 for a GPIO
#     expander at startup), read-only /sys, and a scratch HOME.
#
# Needs root (for the namespaces). Installs python3-pytest and faketime if missing.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
TREE=/opt/fpp
while [ $# -gt 0 ]; do
    case "$1" in
    --fpp) TREE="$2"; shift 2 ;;
    *) break ;;
    esac
done
TREE=$(cd "$TREE" && pwd)

if [ "$(uname -s)" != "Linux" ]; then
    echo "run-local.sh needs Linux namespaces; use run.sh (Docker) on this machine" >&2
    exit 2
fi
if [ "$(id -u)" != 0 ]; then
    echo "run-local.sh needs root for its private namespaces (try sudo)" >&2
    exit 2
fi
if [ ! -x "$TREE/src/fppd" ]; then
    echo "$TREE/src/fppd is not built; run make in $TREE/src first" >&2
    exit 2
fi
# pytest runs the suite; libfaketime lets the calendar scenarios fake fppd's
# clock (they skip without it).
MISSING=""
python3 -c "import pytest" 2>/dev/null || MISSING="$MISSING python3-pytest"
ls /usr/lib/*/faketime/libfaketimeMT.so.1 > /dev/null 2>&1 || MISSING="$MISSING faketime"
if [ -n "$MISSING" ]; then
    echo "installing:$MISSING"
    apt-get -q update > /dev/null
    DEBIAN_FRONTEND=noninteractive apt-get -q -y install --no-install-recommends $MISSING
fi

ARTIFACTS="$HERE/artifacts"
rm -rf "$ARTIFACTS"
mkdir -p "$ARTIFACTS"

echo "fpp tree $TREE: $(cd "$TREE" && git describe --tags --dirty 2>/dev/null || echo unknown)," \
     "fppd built $(date -r "$TREE/src/fppd" '+%Y-%m-%d %H:%M')"

export FPP_TREE="$TREE" FPP_TESTS_HERE="$HERE" FPP_TESTS_ARTIFACTS="$ARTIFACTS"

# unshare makes every mount in the new namespace private, so nothing below is
# visible to the host or outlives the run.
exec unshare --mount --net --fork sh -c '
    set -e
    ip link set lo up
    for d in /tmp /run /dev/shm; do
        mount -t tmpfs -o mode=1777 tmpfs "$d"
    done
    mkdir -p /tmp/overlay/upper /tmp/overlay/work /tmp/home
    mount -t overlay overlay \
        -o "lowerdir=$FPP_TREE,upperdir=/tmp/overlay/upper,workdir=/tmp/overlay/work" "$FPP_TREE"
    if [ -d /dev/snd ]; then mount -t tmpfs tmpfs /dev/snd; fi
    for f in /dev/spidev*; do
        if [ -e "$f" ]; then mount --bind /dev/null "$f"; fi
    done
    mount --bind /sys /sys
    mount -o remount,bind,ro /sys
    export HOME=/tmp/home XDG_CACHE_HOME=/tmp/home/.cache
    cd "$FPP_TESTS_HERE"
    if [ $# -eq 0 ]; then set -- scenarios; fi
    exec python3 -m pytest -p no:cacheprovider "$@"
' sh "$@"
