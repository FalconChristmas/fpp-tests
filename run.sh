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
# runs of the same commit and flavor share that tree: each run gets its own
# copy of the file, mounted over the tree's, so one run's fppd can't be handed
# another's media directory.
MEDIA_ROOT=$(mktemp "${TMPDIR:-/tmp}/fpp-tests-media-root.XXXXXX")
make_test_network
trap 'rm -f "$MEDIA_ROOT"; remove_test_network' EXIT

# The scenarios make network and mount namespaces (fake devices, fppinit),
# which Docker's default AppArmor profile forbids even with SYS_ADMIN: on a
# host with AppArmor (GitHub's runners) they would all be skipped.
TTY=""
[ -t 1 ] && TTY="-t"
# The container runs as root; what it leaves in artifacts/ is handed back to
# the caller (HOST_OWNER) when it finishes.
$DOCKER $TTY --network "$NETWORK" -v "$HERE:/tests:ro" -v "$ARTIFACTS:/artifacts" \
    -v "$MEDIA_ROOT:$TREE/www/media_root.txt" \
    -e FPP_TREE="$TREE" -e FPP_FLAVOR="$FLAVOR" -e FPP_TESTS_ARTIFACTS=/artifacts \
    -e HOST_OWNER="$(id -u):$(id -g)" \
    --cap-add SYS_PTRACE --cap-add SYS_NICE --cap-add NET_ADMIN --cap-add SYS_ADMIN \
    --security-opt apparmor=unconfined \
    --tmpfs /tmp:rw,exec,nosuid,size=4g \
    fpp-tests-env sh -c 'exec 8< "$FPP_TREE" && flock -s 8 || exit 1
        /tests/scripts/build-fpp.sh "$FPP_TREE" "$FPP_FLAVOR" || exit 1
        cd /tests || exit 1
        if [ $# -eq 0 ]; then set -- scenarios; fi
        set -- --junitxml=/artifacts/junit.xml "$@"
        python3 -m pytest -p no:cacheprovider "$@"; rc=$?
        if [ "$FPP_FLAVOR" = coverage ]; then
            /tests/scripts/coverage-report.sh "$FPP_TREE" /artifacts/coverage
        fi
        find /artifacts -mindepth 1 ! -path /artifacts/web ! -path "/artifacts/web/*" \
            -exec chown -h "$HOST_OWNER" {} +
        exit $rc' sh "$@" || exit $?
