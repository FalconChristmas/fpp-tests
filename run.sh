#!/bin/sh
# Build fpp at a given ref and run the scenario suite against it, in Docker.
#
#   ./run.sh [--fpp DIR] [--ref REF] [--flavor asan|tsan|debug|optimized|coverage] [--nopch] [-j N] [pytest args...]
#
# With no pytest args it runs every scenario; otherwise pass paths or node ids
# as usual, e.g. scenarios/test_playlists.py -k Restart -v
#
# --fpp     the fpp git checkout to export from (default ../fpp)
# --ref     any commit-ish in that checkout (default HEAD)
# --flavor  make target to build (default asan); coverage also writes
#           artifacts/coverage/ (scripts/coverage-report.sh)
# --nopch   fail if fpp doesn't build without its precompiled header, rather
#           than falling back to it (which old commits need); CI uses it on
#           fpp master
# -j N      run the scenarios as N shards side by side (scripts/shard.py),
#           each in a container and on a network of its own; a shard's
#           output goes to artifacts/shard-N.log. Most of a scenario's time
#           is waiting, so this goes about N times faster until the VM's
#           memory runs out: an ASan shard peaks under 1GB.
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
JOBS=1
while [ $# -gt 0 ]; do
    case "$1" in
    -j) JOBS="$2"; shift 2 ;;
    -j[0-9]*) JOBS="${1#-j}"; shift ;;
    --fpp) FPP="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --flavor) FLAVOR="$2"; shift 2 ;;
    --nopch) export FPP_TESTS_NOPCH=require; shift ;;
    *) break ;;
    esac
done
case "$JOBS" in
'' | *[!0-9]* | 0) echo "-j takes a number of shards, not '$JOBS'" >&2; exit 2 ;;
esac

. "$HERE/scripts/prepare-tree.sh"

# A failed scenario's media directory (fppd.log, sanitizer reports, the config
# it ran with) is copied here.
# Emptied rather than removed and recreated: Docker Desktop's file sharing
# can still hold the old directory when the next run mounts the path, and that
# run's results then go nowhere (seen with back-to-back runs on macOS).
# artifacts/web is run-web.sh's, which may be running now: emptying it would
# leave that run's container writing to a directory no longer there.
# It is emptied through the container: a run that was killed before handing
# its files back (below) leaves them owned by the container's root.
ARTIFACTS="$HERE/artifacts"
mkdir -p "$ARTIFACTS"
$DOCKER -v "$ARTIFACTS:/artifacts" fpp-tests-env \
    find /artifacts -mindepth 1 ! -path /artifacts/web ! -path "/artifacts/web/*" -delete

# fppd finds its media directory through www/media_root.txt in the tree, and
# runs of the same commit and flavor share that tree: each run (each shard)
# gets its own copy of the file, mounted over the tree's, so one run's fppd
# can't be handed another's media directory.
MEDIA_ROOTS=""
NETWORKS=""
NAMES=""
cleanup() {
    [ -z "$NAMES" ] || docker rm -f $NAMES > /dev/null 2>&1 || true
    for NETWORK in $NETWORKS; do remove_test_network; done
    [ -z "$MEDIA_ROOTS" ] || rm -f $MEDIA_ROOTS
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Runs in the container: $1 is where the results go, $2 "report" to write
# the coverage report afterwards, and the rest are pytest's arguments.
# The container runs as root; what it leaves in artifacts/ is handed back to
# the caller (HOST_OWNER) when it finishes.
INNER='exec 8< "$FPP_TREE" && flock -s 8 || exit 1
    /tests/scripts/build-fpp.sh "$FPP_TREE" "$FPP_FLAVOR" || exit 1
    cd /tests || exit 1
    junit="$1"; report="$2"; shift 2
    if [ $# -eq 0 ]; then set -- scenarios; fi
    python3 -m pytest -p no:cacheprovider --junitxml="$junit" "$@"; rc=$?
    if [ "$FPP_FLAVOR" = coverage ] && [ "$report" = report ]; then
        /tests/scripts/coverage-report.sh "$FPP_TREE" /artifacts/coverage
    fi
    find /artifacts -mindepth 1 ! -path /artifacts/web ! -path "/artifacts/web/*" \
        -exec chown -h "$HOST_OWNER" {} +
    exit $rc'

# A network and a media_root.txt for the next run_scenarios (NETWORK and
# MEDIA_ROOT). Made here, not in run_scenarios, which a shard runs in the
# background: what a subshell sets, cleanup never sees.
new_environment() {
    make_test_network "$1"
    NETWORKS="$NETWORKS $NETWORK"
    MEDIA_ROOT=$(mktemp "${TMPDIR:-/tmp}/fpp-tests-media-root.XXXXXX")
    MEDIA_ROOTS="$MEDIA_ROOTS $MEDIA_ROOT"
}

# Starts one scenario container, in new_environment's network and media root:
# run_scenarios [docker options...] -- [INNER's arguments...].
# The scenarios make network and mount namespaces (fake devices, fppinit),
# which Docker's default AppArmor profile forbids even with SYS_ADMIN: on a
# host with AppArmor (GitHub's runners) they would all be skipped.
run_scenarios() {
    opts=""
    while [ "$1" != -- ]; do opts="$opts $1"; shift; done
    shift
    $DOCKER $opts --network "$NETWORK" -v "$HERE:/tests:ro" -v "$ARTIFACTS:/artifacts" \
        -v "$MEDIA_ROOT:$TREE/www/media_root.txt" \
        -e FPP_TREE="$TREE" -e FPP_FLAVOR="$FLAVOR" -e FPP_TESTS_ARTIFACTS=/artifacts \
        -e HOST_OWNER="$(id -u):$(id -g)" \
        --cap-add SYS_PTRACE --cap-add SYS_NICE --cap-add NET_ADMIN --cap-add SYS_ADMIN \
        --security-opt apparmor=unconfined \
        --tmpfs /tmp:rw,exec,nosuid,size=4g \
        fpp-tests-env sh -c "$INNER" sh "$@"
}

if [ "$JOBS" -eq 1 ]; then
    TTY=""
    [ -t 1 ] && TTY="-t"
    new_environment
    run_scenarios $TTY -- /artifacts/junit.xml report "$@" || exit $?
    exit 0
fi

# Sharded. The pytest arguments that name scenarios (files, directories, node
# ids) are what the shards split; the rest go to every shard.
quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
ITEMS=""
OPTS=""
for a in "$@"; do
    if [ -e "$HERE/${a%%::*}" ]; then ITEMS="$ITEMS $(quote "$a")"; else OPTS="$OPTS $(quote "$a")"; fi
done
# Built once, before the shards start, so a build failure is shown once.
$DOCKER -v "$HERE:/tests:ro" fpp-tests-env sh -c 'exec 8< "$1" && flock -s 8 &&
    /tests/scripts/build-fpp.sh "$1" "$2"' sh "$TREE" "$FLAVOR"
eval "set -- $ITEMS"
SPLIT=$($DOCKER -v "$HERE:/tests:ro" fpp-tests-env sh -c 'n=$1; shift
    for i in $(seq 1 "$n"); do python3 /tests/scripts/shard.py "$i" "$n" "$@" | sed "s/^/$i /"; done' sh "$JOBS" "$@")
eval "set -- $OPTS"
SHARDS=""
for i in $(seq 1 "$JOBS"); do
    FILES=$(echo "$SPLIT" | awk -v i="$i" '$1 == i { print $2 }')
    [ -n "$FILES" ] || continue
    new_environment "$i"
    if [ "$NETWORK" = bridge ]; then
        # Shards on one network see each other's MultiSync traffic.
        echo "shards need a network each; run with fewer, or prune Docker's networks" >&2
        exit 1
    fi
    NAME="fpp-tests-$$-$i"
    NAMES="$NAMES $NAME"
    run_scenarios --name "$NAME" -- "/artifacts/junit-$i.xml" no "$@" $FILES \
        > "$ARTIFACTS/shard-$i.log" 2>&1 &
    SHARDS="$SHARDS $i:$!"
    echo "shard $i: $(echo "$FILES" | wc -l | tr -d ' ') files, artifacts/shard-$i.log"
done

RC=0
JUNITS=""
for s in $SHARDS; do
    i=${s%%:*}
    if ! wait "${s#*:}"; then RC=1; fi
    JUNITS="$JUNITS /artifacts/junit-$i.xml"
    echo "shard $i: $(tail -n 1 "$ARTIFACTS/shard-$i.log")"
done
NAMES=""

$DOCKER -v "$HERE:/tests:ro" -v "$ARTIFACTS:/artifacts" -e HOST_OWNER="$(id -u):$(id -g)" fpp-tests-env sh -c '
    python3 /tests/scripts/merge-junit.py /artifacts/junit.xml "$@"; rc=$?
    rm -f "$@"
    chown "$HOST_OWNER" /artifacts/junit.xml
    exit $rc' sh $JUNITS || RC=1
if [ "$FLAVOR" = coverage ]; then
    $DOCKER -v "$HERE:/tests:ro" -v "$ARTIFACTS:/artifacts" -e HOST_OWNER="$(id -u):$(id -g)" fpp-tests-env sh -c '
        /tests/scripts/coverage-report.sh "$1" /artifacts/coverage
        chown -R "$HOST_OWNER" /artifacts/coverage' sh "$TREE" || RC=1
fi
exit $RC
