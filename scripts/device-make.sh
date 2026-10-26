#!/bin/sh
# make for a device run (the Device workflow and the nightly's device jobs),
# run in fpp/src: make "$@" into build.log, printing its errors if it fails.
# A BeagleBone compiles nothing itself -- it would thrash the board -- but
# through nocc, on the servers the runner's .env names (NOCC_SERVERS,
# semicolon-separated: with any other separator nocc quietly compiles
# locally). DISTRIBUTED_COMPILE drops the precompiled header, which nocc
# can't send.
#
# "coverage" as the target is the coverage flavor, as build-fpp.sh makes it
# in Docker: the debug target at -O0 with --coverage, and gcov-exit.so beside
# the tree (scenarios/fppd.py preloads it: fppd leaves through _exit(), which
# otherwise writes no counts). On a BeagleBone it goes through nocc too,
# which has to bring back each compile's .gcno beside its object.
set -e
coverage=
if [ "$1" = coverage ]; then
    coverage=1
    shift
    set -- debug "OPTIMIZE_FLAGS=-g -O0 -Wno-psabi --coverage" "$@"
    export LDFLAGS=--coverage
fi
if grep -qi beagle /proc/device-tree/model 2>/dev/null; then
    if [ -z "$NOCC_SERVERS" ]; then
        echo "a BeagleBone builds through nocc: set NOCC_SERVERS in the runner's .env" >&2
        exit 1
    fi
    export NOCC_GO_EXECUTABLE="${NOCC_GO_EXECUTABLE:-/usr/bin/nocc-daemon}" CCACHE_PREFIX=nocc
    # -j3 for a 512MB board, -j5 for 1GB
    mem=$(awk '/^MemTotal/ { print $2 }' /proc/meminfo)
    set -- DISTRIBUTED_COMPILE=1 -j"$([ "$mem" -gt 700000 ] && echo 5 || echo 3)" "$@"
else
    set -- -j"$(nproc)" "$@"
fi
# A tree kept between runs (an AM335x board's) may have been built another
# way: make rebuilds nothing for new flags, so a debug tree's objects would
# stand in a coverage build without their .gcno. Other arguments than last
# time, or none recorded, start it clean.
if [ "$(cat .device-make 2>/dev/null)" != "$*" ]; then
    make clean > /dev/null 2>&1 || true
fi
echo "$*" > .device-make
if ! make "$@" > build.log 2>&1; then
    grep -E "error|Error" build.log | tail -40
    exit 1
fi
if [ -n "$coverage" ]; then
    gcc -shared -fPIC -O2 -o ../gcov-exit.so "$(dirname "$0")/gcov-exit.c"
fi
