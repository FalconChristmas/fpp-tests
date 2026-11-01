import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { SETTINGS, keepingSettings, readSettingsFile } from './privacy-helpers';

// Changing a setting from PHP (WriteSettingToFile, behind PUT
// /api/settings/<name>) takes an exclusive lock on the settings file, so it
// waits for anyone reading the file -- fppd or another request, each holding
// a shared lock -- instead of rewriting the file under them.
//
// Regression: de79af450 ("Try to use flock to lock the settings file when
// using it in php").  The write took no lock.  The read half of that commit
// (a shared lock in ReadSettingFromFile) can't be seen from a request: every
// request loads the settings in config.php, under its own shared lock, and
// waits there for a writer before ReadSettingFromFile is reached.

test.skip(!container, 'holds a lock on the settings file inside the run-web.sh container');

const HOLD_S = 4;

// Hold a shared lock on the settings file for HOLD_S seconds, as a reader
// does; returns once it is held (an exclusive one is refused).
function holdReaderLock() {
  inPlayer('sh', '-c', `setsid flock -s ${SETTINGS} sleep ${HOLD_S} > /dev/null 2>&1 < /dev/null &
    for i in $(seq 50); do flock -n -x ${SETTINGS} true || exit 0; sleep 0.1; done; exit 1`);
}

test.afterEach(() => { inPlayer('sh', '-c', 'pkill -x flock; true'); });

test('changing a setting waits for a reader of the settings file, then lands in it', async ({ request }) => {
  await keepingSettings(async () => {
    holdReaderLock();
    const t0 = Date.now();
    const r = await request.put('/api/settings/ScheduleDistance', { data: '37', timeout: 30_000 });
    const took = Date.now() - t0;
    expect(r.ok()).toBe(true);
    expect(took, 'the write did not wait for the reader\'s lock').toBeGreaterThan((HOLD_S - 1.5) * 1000);
    expect(readSettingsFile()).toMatch(/^ScheduleDistance\s*=\s*"?37"?$/m);
  });
});

test('the control: with no lock held a setting is changed at once', async ({ request }) => {
  await keepingSettings(async () => {
    const t0 = Date.now();
    const r = await request.put('/api/settings/ScheduleDistance', { data: '38', timeout: 30_000 });
    expect(r.ok()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(readSettingsFile()).toMatch(/^ScheduleDistance\s*=\s*"?38"?$/m);
  });
});
