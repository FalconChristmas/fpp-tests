#!/bin/sh
# Prove a scenario guards a fix: it must FAIL on the fix's parent and PASS on
# the fix itself. A test that passes on both proves nothing.
#
#   scripts/verify-fix.sh [--fpp DIR] [--base REF] [--flavor F] [--nopch] [--artifacts DIR] FIX_SHA [pytest args...]
#   scripts/verify-fix.sh [...] FIX_SHA web/tests/SPEC [playwright args...]
#
# A path under web/ runs that web UI test through run-web.sh instead.
#
# --base    the "before" tree, when the parent is not it (default FIX_SHA^) --
#           e.g. when an earlier backstop already masks the bug at the parent.
# --flavor  the build both runs use (run.sh's --flavor, default asan): tsan for
#           a race or a lock misuse, which ASan doesn't see.
# --nopch   both builds must build without the precompiled header (run.sh's
#           --nopch): for a fix to a file that doesn't include what it uses,
#           whose red side is then the build itself.
# --artifacts  where the two runs' results go, in before/ and after/ (default
#           artifacts/, or artifacts/web/ for a web test), so the red side's
#           failure is still there to read once the green side has run. Give
#           each verify-fix.sh running at the same time its own.
#
#   scripts/verify-fix.sh 7e171ae48 scenarios/test_command_presets.py -k reload
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
FPPARG=""
BASE=""
FLAVORARG=""
ARTIFACTS=""
while [ $# -gt 0 ]; do
    case "$1" in
    --fpp) FPPARG="--fpp $2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --flavor) FLAVORARG="--flavor $2"; shift 2 ;;
    --nopch) export FPP_TESTS_NOPCH=require; shift ;;
    --artifacts) ARTIFACTS="$2"; shift 2 ;;
    *) break ;;
    esac
done
FIX="$1"; shift
[ -n "$FIX" ] || { echo "usage: $0 [--fpp DIR] [--base REF] [--flavor F] [--nopch] [--artifacts DIR] FIX_SHA [pytest args...]" >&2; exit 2; }
[ -n "$BASE" ] || BASE="$FIX^"

RUNNER="$HERE/run.sh"
QUIET=-q
DEFAULT_ARTIFACTS="$HERE/artifacts"
case "$1" in
web/*)
    RUNNER="$HERE/run-web.sh"
    QUIET=--quiet
    DEFAULT_ARTIFACTS="$HERE/artifacts/web"
    # Playwright runs in web/, so the spec's path is relative to it.
    SPEC="${1#web/}"; shift; set -- "$SPEC" "$@" ;;
esac

[ -n "$ARTIFACTS" ] || ARTIFACTS="$DEFAULT_ARTIFACTS"

echo "=== before the fix ($BASE): expecting FAIL"
if "$RUNNER" $FPPARG $FLAVORARG --artifacts "$ARTIFACTS/before" --ref "$BASE" $QUIET "$@"; then
    echo "FAIL: the scenario passes without the fix, so it does not test it" >&2
    exit 1
fi
echo "=== with the fix ($FIX): expecting PASS"
if ! "$RUNNER" $FPPARG $FLAVORARG --artifacts "$ARTIFACTS/after" --ref "$FIX" $QUIET "$@"; then
    echo "FAIL: the scenario fails with the fix in place (results: $ARTIFACTS/after)" >&2
    exit 1
fi
echo "OK: red before $FIX, green with it; read the red side's failure in $ARTIFACTS/before"

