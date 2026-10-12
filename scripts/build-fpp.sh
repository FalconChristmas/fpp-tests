#!/bin/sh
# Runs inside the container. Builds the exported tree at $1 with make target
# $2 (asan, tsan, debug or optimized) unless it was already built.
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

export CCACHE_DIR=/ccache
export CCACHE=ccache
# DISTRIBUTED_COMPILE=1 turns off the precompiled header, which is built with
# the release flags whatever the target; it also proves every file includes
# what it uses. Older commits are not always clean that way (a header the PCH
# happened to supply), so on failure fall back to a PCH build of the rest --
# PCH and NOPCH objects link together fine.
if ! make -j"$(nproc)" DISTRIBUTED_COMPILE=1 "$FLAVOR" > "$TREE/build.log" 2>&1; then
    echo "NOPCH build failed, retrying with the precompiled header:" >&2
    grep -E "error:" "$TREE/build.log" | head -5 >&2
    if ! make -j"$(nproc)" "$FLAVOR" >> "$TREE/build.log" 2>&1; then
        grep -E "error|Error" "$TREE/build.log" | tail -40
        echo "build failed; full log in $TREE/build.log" >&2
        exit 1
    fi
fi
touch .fpp-tests-built
