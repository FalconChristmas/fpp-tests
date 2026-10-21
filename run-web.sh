#!/bin/sh
# Build fpp at a given ref, serve its web UI from Docker, and run the
# Playwright suite in web/ against it from this machine.
#
#   ./run-web.sh [--fpp DIR] [--ref REF] [--flavor asan|tsan|debug|optimized] [--port N] [playwright args...]
#
# The options are run.sh's; --port is where the UI is published on 127.0.0.1
# (default 8080). Anything else goes to `playwright test`, e.g.
#   ./run-web.sh tests/fpp.spec.ts -g "Unsaved"
#
# --serve only serves the UI, until Ctrl-C, for writing a test against it:
#   ./run-web.sh --serve        then, in web/: npx playwright test --ui
#
# fppd behind the UI is the same build the scenarios use (ASan by default), and
# is held to the same standard: the run fails if fppd died, wedged, exited
# non-zero on SIGTERM or wrote a sanitizer report while the pages drove it.
#
# Needs Node.js 20+ here; the first run installs the suite's packages and its
# Chromium. Results go to artifacts/web/: junit.xml, the HTML report, failed
# tests' screenshots and traces, fppd.json (fppd's verdict) and, when fppd
# failed, its media directory and Apache's logs.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
FPP="$HERE/../fpp"
REF=HEAD
FLAVOR=asan
PORT=${FPP_TESTS_WEB_PORT:-8080}
SERVE=
while [ $# -gt 0 ]; do
    case "$1" in
    --fpp) FPP="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --flavor) FLAVOR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --serve) SERVE=1; shift ;;
    *) break ;;
    esac
done

. "$HERE/scripts/prepare-tree.sh"

docker build -q -t fpp-tests-web "$HERE/docker/web" > /dev/null

ARTIFACTS="$HERE/artifacts/web"
mkdir -p "$ARTIFACTS"
# Emptied through a container: the web container runs as root, and a run that
# stopped before handing its files back (below) leaves them owned by root,
# e.g. apache2/, which the next run (and verify-fix.sh's second) can't delete.
$DOCKER -v "$ARTIFACTS:/artifacts" fpp-tests-env find /artifacts -mindepth 1 -delete

$DOCKER -v "$HERE:/tests:ro" fpp-tests-env /tests/scripts/build-fpp.sh "$TREE" "$FLAVOR"

if [ ! -d "$HERE/web/node_modules" ]; then
    (cd "$HERE/web" && npm ci --no-audit --no-fund && npx playwright install chromium)
fi

# Not --rm: the container's exit code is fppd's verdict, read after it stops.
NAME="fpp-tests-web-$$"
make_test_network
trap 'docker rm -f "$NAME" > /dev/null 2>&1 || true; remove_test_network' EXIT
${DOCKER%%--rm*}${DOCKER#*--rm} -d --init --name "$NAME" --network "$NETWORK" -p "127.0.0.1:$PORT:80" \
    -v "$HERE:/tests:ro" -v "$ARTIFACTS:/artifacts" \
    -e FPP_TREE="$TREE" -e FPP_TESTS_ARTIFACTS=/artifacts \
    --cap-add SYS_PTRACE --cap-add SYS_NICE \
    --tmpfs /tmp:rw,exec,nosuid,size=4g \
    fpp-tests-web python3 /tests/scripts/web_serve.py > /dev/null

echo "waiting for the web UI on 127.0.0.1:$PORT"
i=0
until docker logs "$NAME" 2>&1 | grep -q '^READY$'; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
        docker logs "$NAME" 2>&1 | tail -40
        echo "the web container exited before it was ready" >&2
        exit 1
    fi
    i=$((i + 1))
    if [ $i -gt 300 ]; then
        docker logs "$NAME" 2>&1 | tail -40
        echo "the web UI was not ready within 5 minutes" >&2
        exit 1
    fi
    sleep 1
done

if [ -n "$SERVE" ]; then
    echo "serving fpp $DESCRIBE at http://127.0.0.1:$PORT/ until Ctrl-C"
    echo "(container $NAME: FPP_TESTS_WEB_CONTAINER=$NAME for the tests that need it)"
    trap 'docker stop -t 120 "$NAME" > /dev/null; docker rm -f "$NAME" > /dev/null 2>&1; remove_test_network; exit 0' INT TERM
    docker wait "$NAME" > /dev/null
    exit 1
fi

rc=0
# FPP_TESTS_WEB_CONTAINER: for the tests that act from inside the player.
(cd "$HERE/web" && PLAYWRIGHT_BASE_URL="http://127.0.0.1:$PORT" FPP_TESTS_WEB_ARTIFACTS="$ARTIFACTS" \
    FPP_TESTS_WEB_CONTAINER="$NAME" npx playwright test "$@") || rc=$?

# SIGTERM: web_serve.py stops fppd and judges it; give an ASan fppd time.
docker stop -t 120 "$NAME" > /dev/null
fppd_rc=$(docker wait "$NAME")
# Hand what the container wrote (fppd.json, apache2/, media/) back to the caller.
$DOCKER -v "$ARTIFACTS:/artifacts" fpp-tests-env chown -hR "$(id -u):$(id -g)" /artifacts
if [ "$fppd_rc" != 0 ]; then
    docker logs "$NAME" 2>&1 | tail -60
    echo "fppd failed under the web suite (exit $fppd_rc); see artifacts/web/fppd.json" >&2
    [ $rc -ne 0 ] || rc=1
fi
exit $rc
