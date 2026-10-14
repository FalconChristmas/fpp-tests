#!/bin/sh
# Build fpp at a given ref and run the scenario suite against it, in Docker.
#
#   ./run.sh [--fpp DIR] [--ref REF] [--flavor asan|tsan|debug|optimized|coverage] [pytest args...]
#
# With no pytest args it runs every scenario; otherwise pass paths or node ids
# as usual, e.g. scenarios/test_playlists.py -k Restart -v
#
# --fpp     the fpp git checkout to export from (default ../fpp)
# --ref     any commit-ish in that checkout (default HEAD)
# --flavor  make target to build (default asan); coverage also writes
#           artifacts/coverage/ (scripts/coverage-report.sh)
#
# The results, one entry per test, go to artifacts/junit.xml.
#
# Builds are cached per (commit, flavor) in the fpp-tests-work Docker volume
# and object files in fpp-tests-ccache, so re-runs and nearby commits are fast.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
FPP="$HERE/../fpp"
REF=HEAD
FLAVOR=asan
while [ $# -gt 0 ]; do
    case "$1" in
    --fpp) FPP="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --flavor) FLAVOR="$2"; shift 2 ;;
    *) break ;;
    esac
done

SHA=$(git -C "$FPP" rev-parse --verify "$REF^{commit}")
TREE="/work/$(echo "$SHA" | cut -c1-12)-$FLAVOR"
DESCRIBE=$(git -C "$FPP" describe --tags --match='[0-9]*' "$SHA" 2>/dev/null || echo "$SHA")
echo "fpp $REF = $DESCRIBE ($SHA), flavor $FLAVOR"

docker build -q -t fpp-tests-env "$HERE/docker" > /dev/null

# ccache lives in a named volume, or in a host directory when
# FPP_TESTS_CCACHE is set (CI caches that directory between runs).
CCACHE_MOUNT="fpp-tests-ccache:/ccache"
if [ -n "$FPP_TESTS_CCACHE" ]; then
    mkdir -p "$FPP_TESTS_CCACHE"
    CCACHE_MOUNT="$(cd "$FPP_TESTS_CCACHE" && pwd):/ccache"
fi
# fppd's exit path visits every descriptor up to the open-file limit, and
# some Docker setups (WSL's) default it to 2^30: under TSan that takes longer
# than any scenario waits for fppd to exit.
DOCKER="docker run --rm --ulimit nofile=1048576:1048576 -v fpp-tests-work:/work -v $CCACHE_MOUNT"

# A failed scenario's media directory (fppd.log, sanitizer reports, the config
# it ran with) is copied here.
ARTIFACTS="$HERE/artifacts"
rm -rf "$ARTIFACTS"
mkdir -p "$ARTIFACTS"

# Each built tree is ~500MB; keep the most recently used FPP_TESTS_KEEP_TREES.
# (touch only an existing tree: on a new one it would create a plain file.)
$DOCKER fpp-tests-env sh -c "if [ -d '$TREE' ]; then touch '$TREE'; fi; ls -1dt /work/*/ 2>/dev/null |
    tail -n +$((${FPP_TESTS_KEEP_TREES:-8} + 1)) | xargs -r rm -rf"

# Export the tree once per commit and flavor; flavors can't share object files.
# An export has no .git, so fppversion.sh reads the version from
# src/EXPORTED_VERSION instead of git describe.
if ! $DOCKER fpp-tests-env test -d "$TREE"; then
    git -C "$FPP" archive --format=tar "$SHA" |
        $DOCKER -i fpp-tests-env sh -c "rm -rf '$TREE.tmp' && mkdir -p '$TREE.tmp' && tar -x -C '$TREE.tmp' &&
            printf 'SOURCE_VERSION=%s\\nBRANCH=fpp-tests\\n' '$DESCRIBE' > '$TREE.tmp/src/EXPORTED_VERSION' &&
            mv '$TREE.tmp' '$TREE'"
fi

# The scenarios make network and mount namespaces (fake devices, fppinit),
# which Docker's default AppArmor profile forbids even with SYS_ADMIN: on a
# host with AppArmor (GitHub's runners) they would all be skipped.
TTY=""
[ -t 1 ] && TTY="-t"
exec $DOCKER $TTY -v "$HERE:/tests:ro" -v "$ARTIFACTS:/artifacts" \
    -e FPP_TREE="$TREE" -e FPP_FLAVOR="$FLAVOR" -e FPP_TESTS_ARTIFACTS=/artifacts \
    --cap-add SYS_PTRACE --cap-add SYS_NICE --cap-add NET_ADMIN --cap-add SYS_ADMIN \
    --security-opt apparmor=unconfined \
    --tmpfs /tmp:rw,exec,nosuid,size=4g \
    fpp-tests-env sh -c '/tests/scripts/build-fpp.sh "$FPP_TREE" "$FPP_FLAVOR" || exit 1
        cd /tests || exit 1
        if [ $# -eq 0 ]; then set -- scenarios; fi
        set -- --junitxml=/artifacts/junit.xml "$@"
        if [ "$FPP_FLAVOR" != coverage ]; then exec python3 -m pytest -p no:cacheprovider "$@"; fi
        python3 -m pytest -p no:cacheprovider "$@"; rc=$?
        /tests/scripts/coverage-report.sh "$FPP_TREE" /artifacts/coverage; exit $rc' sh "$@"
