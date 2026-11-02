import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: ffe62dfa2.  The date pickers (the scheduler's, and every page's
// through fpp.js) offer the years MINYEAR to MAXYEAR, which config.php set as
// two before and five after the current year.  A player with no network has
// no time source and wakes with its clock wherever the RTC (or the image's
// build date) left it, so the schedule's dates, picked from a range around
// the wrong year, could not be set to the year the show really runs.  Outside
// the years config.php believes a real clock can be in, the range is wide.
//
// The clock is the PHP workers' only: they are restarted under libfaketime
// (which the image has) for each year, and restarted without it afterwards.

test.skip(!container, 'restarts php-fpm inside the run-web.sh container');
test.describe.configure({ mode: 'serial' });

const FAKETIME = 'LD_PRELOAD=$(ls /usr/lib/*/faketime/libfaketime.so.1 | head -1)';

function restartFpm(fake?: string) {
  inPlayer('sh', '-c', `pkill -x php-fpm8.4; while pgrep -x php-fpm8.4 > /dev/null; do sleep 0.2; done; ` +
    (fake ? `${FAKETIME} FAKETIME='@${fake}' php-fpm8.4 -R` : 'php-fpm8.4 -R'));
}

test.afterAll(() => restartFpm());

async function range(request: any, year: number) {
  restartFpm(`${year}-06-01 12:00:00`);
  let body = '';
  await expect.poll(async () => {
    const r = await request.get('/index.php?y=' + year);
    body = await r.text();
    return /MINYEAR = \d+/.test(body);
  }, { timeout: 15_000 }).toBe(true);
  return [Number(/MINYEAR = (\d+)/.exec(body)![1]), Number(/MAXYEAR = (\d+)/.exec(body)![1])];
}

test('the year range is two back and five ahead of a plausible clock', async ({ request }) => {
  // The control: the clock is where it looks right.
  expect(await range(request, 2027)).toEqual([2025, 2032]);
});

test('a clock far from the present gets a wide year range', async ({ request }) => {
  // A clock stuck in the past (a Pi with a dead RTC and no network).
  const [min, max] = await range(request, 2019);
  expect(min, 'the range starts after the real year').toBeLessThanOrEqual(2019 - 10);
  expect(max, 'the range ends before the real year').toBeGreaterThanOrEqual(2019 + 10);
  // And one set well ahead.
  const [min2, max2] = await range(request, 2035);
  expect(min2, 'the range starts after the real year').toBeLessThanOrEqual(2035 - 10);
  expect(max2, 'the range ends before the real year').toBeGreaterThanOrEqual(2035 + 10);
});
