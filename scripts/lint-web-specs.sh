#!/bin/sh
# Checks web/tests for patterns that let a spec pass while testing the wrong
# thing.  run-web.sh runs it before Playwright; run it alone from anywhere.
#
#   - a spec takes `test` from ./fixtures, not '@playwright/test': the
#     fixtures' page is what fails a test on an uncaught page error and
#     records JS coverage;
#   - no test.only / describe.only;
#   - no page.goto to a fragment (a file another page includes or loads, with
#     no scripts of its own) unless a "// lint: fragment, <why>" comment is on
#     that line or the one above: loaded alone it is not the page users see;
#   - the number of waitForTimeout( calls may go down, never up: a sleep waits
#     for time, not for the thing the test means.  Lower WAIT_LIMIT when it
#     drops.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T="$HERE/web/tests"
WAIT_LIMIT=223
FRAGMENTS='co-[A-Za-z-]+|universeentry|playlistEditor|playlistEntryTypes|playlistDetails|commandEditor|schedulePreview|scheduleCalendar|scheduleentry|fileChooser|settings-[a-z]+|virtualdisplaybody(3d)?'
bad=0

hits=$(grep -nE "import[^;]*\\btest\\b[^;]*from '@playwright/test'" "$T"/*.spec.ts | grep -v "import type")
[ -n "$hits" ] && { echo "Import test from './fixtures', not '@playwright/test':"; echo "$hits"; bad=1; }

hits=$(grep -nE "\\b(test|describe)\\.only\\(" "$T"/*.ts)
[ -n "$hits" ] && { echo "Focused tests left in:"; echo "$hits"; bad=1; }

hits=$(grep -nE "goto\\(['\"\`]/($FRAGMENTS)\\.php" "$T"/*.spec.ts | while IFS=: read -r f n rest; do
    prev=$((n - 1))
    if ! sed -n "${prev}p;${n}p" "$f" | grep -q "lint: fragment"; then echo "$f:$n:$rest"; fi
done)
[ -n "$hits" ] && { echo "page.goto to a fragment (open the page that loads it, or say why with // lint: fragment, <why>):"; echo "$hits"; bad=1; }

waits=$(cat "$T"/*.ts | grep -o "waitForTimeout(" | wc -l)
if [ "$waits" -gt "$WAIT_LIMIT" ]; then
    echo "waitForTimeout( is used $waits times, more than $WAIT_LIMIT: wait for the thing itself."
    bad=1
elif [ "$waits" -lt "$WAIT_LIMIT" ]; then
    echo "note: waitForTimeout( is down to $waits; lower WAIT_LIMIT in $0 to $waits."
fi

[ $bad = 0 ] && echo "Spec lint: clean"
exit $bad
