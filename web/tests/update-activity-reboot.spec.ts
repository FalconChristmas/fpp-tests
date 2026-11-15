import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, docker, inPlayer } from './container';

// An OS upgrade ends in a sysrq reset, and the reset can lose the last lines
// of logs/fpp_system_upgrades.log: the run's "Rebooting" and FINISH.  The
// box then came back showing "FPP OS Upgrade - Finalizing" with Upgrade OS
// locked (#3187), or, once that wore off, "Last update did not finish" after
// an upgrade that worked.  /api/system/updateActivity now ends a run at
// fppinit's once-per-boot "[fpp-boot <boot_id>] System booted" line, does
// not count a log written "in the future" (a clock that came up behind) as
// fresh, and does not let another op's lock revive the run.
//
// Each test writes the log and sets its mtime; nothing is upgraded.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MEDIA = '/home/fpp/media';
const LOG = `${MEDIA}/logs/fpp_system_upgrades.log`;
const LOCK = `${MEDIA}/tmp/fpp-update.lock`;
const IMAGE = 'Pi64-fpp-tests_2099-01.fppos';
const BOOT_ID = '6c1d2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

const stamp = (secondsAgo = 0) =>
  new Date(Date.now() - secondsAgo * 1000).toISOString().replace('T', ' ').slice(0, 19);
const os = (text: string, secondsAgo = 0) => `${stamp(secondsAgo)} [os-upgrade ${IMAGE}] ${text}\n`;
const START = (secondsAgo = 0) => os(`===== os-upgrade START: ${IMAGE} =====`, secondsAgo);
const APPLYING = os('===== Applying OS image =====');
const COPIED = os('Please reboot if the system does not do so automatically');
const BOOTED = `${stamp()} [fpp-boot ${BOOT_ID}] System booted (clock may not be synced yet)\n`;

// The log, as `text`, last written at `mtime` (touch -d's words; now if not given).
function writeLog(text: string, mtime = 'now') {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/logs && printf '%s' "$1" > ${LOG} && touch -d "$2" ${LOG}`, 'sh', text, mtime);
}

async function activity(request: APIRequestContext) {
  const r = await request.get('/api/system/updateActivity');
  expect(r.status()).toBe(200);
  return r.json();
}

test.afterEach(() => {
  inPlayer('sh', '-c', `pkill -f "[s]leep 41" || true; rm -f ${LOG} ${LOCK}`);
});

test('an OS upgrade left open by a reset is not in progress once the box has booted', async ({ request }) => {
  // Regression: d54a72a96 (#3187).  The log had been written in the last
  // 15 minutes, so the open run read as live after the reboot.
  writeLog(START() + APPLYING);
  const live = await activity(request);
  expect(live, 'the control: an open run with a fresh log is live').toMatchObject({ inProgress: true, op: 'os-upgrade' });

  writeLog(START() + APPLYING + BOOTED);
  const after = await activity(request);
  expect(after, JSON.stringify(after)).toMatchObject({ inProgress: false, op: 'os-upgrade', stale: true });
});

test('a log last written "in the future", by a clock that came up behind, is not fresh', async ({ request }) => {
  // Regression: d54a72a96 (#3187).  A PocketBeagle 2 came back 6.5 hours
  // behind, and its open run read as live until the clock caught up.
  writeLog(START() + APPLYING, '+6 hours');
  const r = await activity(request);
  expect(r, JSON.stringify(r)).toMatchObject({ inProgress: false, op: 'os-upgrade', stale: true });
  // The control: the same log written a minute ago is live.
  writeLog(START() + APPLYING, '-1 minute');
  expect((await activity(request)).inProgress).toBe(true);
});

test('a Rebuild holding the update lock is reported as the Rebuild, not as an old open OS upgrade', async ({ request }) => {
  // Regression: d54a72a96 (#3187).  Any holder of the lock made the open
  // run live, so a Rebuild showed as "FPP OS Upgrade".
  writeLog(START(7200) + APPLYING, '-2 hours');
  expect((await activity(request)).stale, 'the control: with nothing holding the lock the run is stale').toBe(true);

  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/tmp && printf '%s' "$1" > ${LOCK} && chmod 666 ${LOCK}`, 'sh',
    JSON.stringify({ op: 'fpp-rebuild', target: '', pid: 1, acquiredAt: Math.floor(Date.now() / 1000) }));
  docker('exec', '-d', container, 'flock', '-n', LOCK, 'sleep', '41');
  await expect.poll(() => inPlayer('sh', '-c', `flock -n ${LOCK} true && echo free || echo held`).trim(),
    { timeout: 5_000 }).toBe('held');
  const r = await activity(request);
  expect(r, JSON.stringify(r)).toMatchObject({ inProgress: true, op: 'fpp-rebuild', kind: 'FPP Rebuild' });
});

test('the same image started again after a boot is a new run', async ({ request }) => {
  // Regression: d54a72a96.  A re-run of the image after a power loss was
  // taken for a continuation of the old run, with its runId, so a dismiss
  // of the old run hid the new one.
  const first = START(120);
  const again = START(10);
  writeLog(first + again);
  const continued = (await activity(request)).runId;
  writeLog(again);
  const alone = (await activity(request)).runId;
  expect(continued, 'the control: a second START with no boot between continues the first run').not.toBe(alone);

  writeLog(first + BOOTED + again);
  expect((await activity(request)).runId).toBe(alone);
});

test('an OS upgrade that finished its copy and then booted reads as complete, not stale', async ({ request }) => {
  // Regression: 88d662e80.  With the "Rebooting" line lost to the reset,
  // the boot ended the run as stale: "Last update did not finish", after an
  // upgrade that worked.  upgradeOS-part1.sh prints "Please reboot if the
  // system does not do so automatically" only when the copy succeeded.
  writeLog(START(3600) + APPLYING + COPIED + BOOTED, '-1 hour');
  const r = await activity(request);
  expect(r, JSON.stringify(r)).toMatchObject({ inProgress: false, op: 'os-upgrade', stale: false, failed: false });
  // The control: without part1's line the same boot leaves it stale.
  writeLog(START(3600) + APPLYING + BOOTED, '-1 hour');
  expect((await activity(request)).stale).toBe(true);
});
