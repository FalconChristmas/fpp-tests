#!/bin/sh
# Prove a scenario guards a fix: it must FAIL on the fix's parent and PASS on
# the fix itself. A test that passes on both proves nothing.
#
#   scripts/verify-fix.sh [--fpp DIR] [--base REF] [--flavor F] FIX_SHA [pytest args...]
#   scripts/verify-fix.sh [...] FIX_SHA web/tests/SPEC [playwright args...]
#
# A path under web/ runs that web UI test through run-web.sh instead.
#
# --base    the "before" tree, when the parent is not it (default FIX_SHA^) --
#           e.g. when an earlier backstop already masks the bug at the parent.
# --flavor  the build both runs use (run.sh's --flavor, default asan): tsan for
#           a race or a lock misuse, which ASan doesn't see.
#
#   scripts/verify-fix.sh 7e171ae48 scenarios/test_command_presets.py -k reload
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
FPPARG=""
BASE=""
FLAVORARG=""
while [ $# -gt 0 ]; do
    case "$1" in
    --fpp) FPPARG="--fpp $2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --flavor) FLAVORARG="--flavor $2"; shift 2 ;;
    *) break ;;
    esac
done
FIX="$1"; shift
[ -n "$FIX" ] || { echo "usage: $0 [--fpp DIR] [--base REF] [--flavor F] FIX_SHA [pytest args...]" >&2; exit 2; }
[ -n "$BASE" ] || BASE="$FIX^"

RUNNER="$HERE/run.sh"
QUIET=-q
case "$1" in
web/*)
    RUNNER="$HERE/run-web.sh"
    QUIET=--quiet
    # Playwright runs in web/, so the spec's path is relative to it.
    SPEC="${1#web/}"; shift; set -- "$SPEC" "$@" ;;
esac

echo "=== before the fix ($BASE): expecting FAIL"
if "$RUNNER" $FPPARG $FLAVORARG --ref "$BASE" $QUIET "$@"; then
    echo "FAIL: the scenario passes without the fix, so it does not test it" >&2
    exit 1
fi
echo "=== with the fix ($FIX): expecting PASS"
if ! "$RUNNER" $FPPARG $FLAVORARG --ref "$FIX" $QUIET "$@"; then
    echo "FAIL: the scenario fails with the fix in place" >&2
    exit 1
fi
echo "OK: red before $FIX, green with it"
