#!/bin/sh
# make for a device run (the Device workflow and the nightly's device job),
# run in fpp/src: make "$@" into build.log, printing its errors if it fails.
# A BeagleBone compiles nothing itself -- it would thrash the board -- but
# through nocc, on the servers the runner's .env names (NOCC_SERVERS,
# semicolon-separated: with any other separator nocc quietly compiles
# locally). DISTRIBUTED_COMPILE drops the precompiled header, which nocc
# can't send. nocc brings back only the object, never a --coverage
# compile's .gcno, so a Beagle can't make a coverage build.
set -e
if grep -qi beagle /proc/device-tree/model 2>/dev/null; then
    if [ -z "$NOCC_SERVERS" ]; then
        echo "a BeagleBone builds through nocc: set NOCC_SERVERS in the runner's .env" >&2
        exit 1
    fi
    case "$*" in *--coverage*)
        echo "nocc can't make a coverage build (it never brings back the .gcno)" >&2
        exit 1 ;;
    esac
    export NOCC_GO_EXECUTABLE="${NOCC_GO_EXECUTABLE:-/usr/bin/nocc-daemon}" CCACHE_PREFIX=nocc
    # -j3 for a 512MB board, -j5 for 1GB
    mem=$(awk '/^MemTotal/ { print $2 }' /proc/meminfo)
    set -- DISTRIBUTED_COMPILE=1 -j"$([ "$mem" -gt 700000 ] && echo 5 || echo 3)" "$@"
else
    set -- -j"$(nproc)" "$@"
fi
if ! make "$@" > build.log 2>&1; then
    grep -E "error|Error" build.log | tail -40
    exit 1
fi
