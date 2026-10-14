#!/bin/sh
# Runs inside the container. Builds the exported tree at $1 with make target
# $2 (asan, tsan, debug, optimized or coverage) unless it was already built.
set -e
TREE="$1"
FLAVOR="$2"
cd "$TREE/src"
if [ -f .fpp-tests-built ]; then
    exit 0
fi
# Build-only fixes for old commits that don't compile under these flags. Each
# applies only where it applies cleanly; a tree that already has it is left
# alone. Name each after the fpp commit it backports.
for p in /tests/fixups/*.patch; do
    [ -f "$p" ] || continue
    if patch -d "$TREE" -p1 -N -s --dry-run < "$p" > /dev/null 2>&1; then
        echo "applying build fixup $(basename "$p")"
        patch -d "$TREE" -p1 -N -s < "$p"
    fi
done

# The compiler's temporaries go on the work volume: /tmp is a tmpfs (run.sh,
# for the fppinit sandbox's overlay), and -j$(nproc) ASan temporaries there
# count against the VM's memory and got the compilers OOM-killed.
export TMPDIR="$TREE/.build-tmp"
mkdir -p "$TMPDIR"
export CCACHE_DIR=/ccache
export CCACHE=ccache
# The coverage flavor is a -O0 --coverage build of the debug target; each
# fppd run adds to the .gcda counts next to the objects, and
# scripts/coverage-report.sh turns them into a report.
TARGET="$FLAVOR"
if [ "$FLAVOR" = coverage ]; then
    TARGET="debug OPTIMIZE_FLAGS=-g\ -O0\ -Wno-psabi\ --coverage"
    export LDFLAGS=--coverage
    gcc -shared -fPIC -O2 -o "$TREE/gcov-exit.so" /tests/scripts/gcov-exit.c
fi
# One job per core, but no more than the memory holds: a sanitizer
# compile of the bigger files takes over a gigabyte, and 16 jobs in Docker
# Desktop's 8 GB VM got cc1plus OOM-killed.
JOBS=$(nproc)
MEM_JOBS=$(awk '/^MemTotal:/ { j = int($2 / 1200000); print (j < 1 ? 1 : j) }' /proc/meminfo)
[ "$MEM_JOBS" -lt "$JOBS" ] && JOBS=$MEM_JOBS
# DISTRIBUTED_COMPILE=1 turns off the precompiled header, which is built with
# the release flags whatever the target; it also proves every file includes
# what it uses. Older commits are not always clean that way (a header the PCH
# happened to supply), so on failure fall back to a PCH build of the rest --
# PCH and NOPCH objects link together fine.
if ! eval make -j"$JOBS" DISTRIBUTED_COMPILE=1 $TARGET > "$TREE/build.log" 2>&1; then
    echo "NOPCH build failed, retrying with the precompiled header:" >&2
    grep -E "error:" "$TREE/build.log" | head -5 >&2
    if ! eval make -j"$JOBS" $TARGET >> "$TREE/build.log" 2>&1; then
        grep -E "error|Error" "$TREE/build.log" | tail -40
        echo "build failed; full log in $TREE/build.log" >&2
        exit 1
    fi
fi
touch .fpp-tests-built
