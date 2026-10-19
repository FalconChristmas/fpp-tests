#!/bin/sh
# Runs inside the container. Builds the exported tree at $1 with make target
# $2 (asan, tsan, debug, optimized or coverage) unless it was already built in
# this image (FPP_TESTS_IMAGE, set by prepare-tree.sh).
set -e
TREE="$1"
FLAVOR="$2"
cd "$TREE/src"
# Runs from several fpp-tests checkouts share the work volume. Build one tree
# at a time: two runs of one commit would otherwise build the same tree at
# once, and each build sizes -j to the whole VM's memory.
exec 9> "$(dirname "$TREE")/.build.lock"
flock 9
# A tree built in an older image is built again: its makefiles leave out what
# that image lacked (gst-rtsp-server, say), and fpp's own feature stamp then
# rebuilds what the new one adds.  Otherwise make finds nothing to do.
if [ -f .fpp-tests-built ] && [ "$(cat .fpp-tests-built)" = "${FPP_TESTS_IMAGE:-}" ]; then
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
# Every commit is exported to its own /work/<sha>-<flavor>, and with -g ccache
# hashes the compiler's working directory, so no tree ever hit another's
# objects: verify-fix's two sides were each a full build. Hash paths relative
# to the tree instead. (Debug info then names the first tree that compiled an
# object; gdb still has the functions and line numbers.)
export CCACHE_BASEDIR="$TREE"
export CCACHE_NOHASHDIR=1
# The coverage flavor is a -O0 --coverage build of the debug target; each
# fppd run adds to the .gcda counts next to the objects, and
# scripts/coverage-report.sh turns them into a report.
TARGET="$FLAVOR"
# The image's /etc/fpp/container makes FPP's makefiles leave out the cape
# tools, which fppinit's cape detection (and its scenarios) need; build them
# as on a device. Nothing in them needs a cape to build.
TARGET="$TARGET BUILD_FPPCAPEDETECT=1"
if [ "$FLAVOR" = coverage ]; then
    TARGET="debug BUILD_FPPCAPEDETECT=1 OPTIMIZE_FLAGS=-g\ -O0\ -Wno-psabi\ --coverage"
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
printf '%s' "${FPP_TESTS_IMAGE:-}" > .fpp-tests-built
# A tree is built once and never incrementally: one built in an older image is
# rebuilt from ccache, which holds every object. Dropping them takes a tree
# from ~540 MB to ~190 MB, so the work volume keeps more of them. (coverage's
# report reads the notes files next to the objects; leave that flavor alone.)
if [ "$FLAVOR" != coverage ]; then
    find "$TREE" -name '*.o' -delete
fi
