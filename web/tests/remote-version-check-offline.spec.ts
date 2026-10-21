import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Every full status request (/api/system/info, /api/system/status) asks
// whether the update source has a newer version.  For github.com that starts
// with a 1-second ping of 8.8.8.8, so a player without internet gives up at
// once.  A custom source skipped that and, when git could not reach it, fell
// back to a ping of github.com with no time limit -- ten seconds where nothing
// answers -- and a failed check is not cached, so every status request paid
// it again.  An UpgradeSource left empty counted as a custom one, though
// scripts/git_pull reads it as github.com.
//
// Regression: fpp 5ee778fb1 ("time-limit and hold off a failed update-source
// check").
//
// ping is replaced for the test by one that gets no reply, as on a network
// that drops ICMP: it waits out -W, or ten seconds without one.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const PING = '/usr/local/bin/ping';
let restoreSettings: () => void;

test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  inPlayer('sh', '-c', `cat > ${PING} <<'P'
#!/bin/sh
echo "$*" >> /tmp/fpp-tests-ping.log
w=10; prev=
for a in "$@"; do [ "$prev" = "-W" ] && w=$a; prev=$a; done
sleep "$w"; exit 1
P
chmod 755 ${PING}; rm -f /tmp/cache_git_* /tmp/fpp-tests-ping.log`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `rm -f ${PING} /tmp/cache_git_* /tmp/fpp-tests-ping.log`);
  restoreSettings();
});

async function timedInfo(request: APIRequestContext) {
  const start = Date.now();
  const r = await request.get('/api/system/info', { timeout: 60_000 });
  const secs = (Date.now() - start) / 1000;
  expect(r.ok()).toBe(true);
  return { secs, json: await r.json() };
}

test('a custom update source that cannot be reached costs a status request little, and only once a minute', async ({ request }) => {
  test.setTimeout(120_000);
  setSettingInFile('UpgradeSource', 'fpp-tests-mirror.invalid');
  const first = await timedInfo(request);
  expect(first.json.RemoteGitVersion).toBe('Unknown');
  expect(first.secs, 'the check waited on an unanswered ping').toBeLessThan(5);
  const pings = () => inPlayer('sh', '-c', 'cat /tmp/fpp-tests-ping.log 2>/dev/null || true').split('\n').filter(Boolean);
  const afterFirst = pings();
  // The control: the first request did check, and waited on a ping.
  expect(afterFirst.length, 'the first request made no check, so this proves nothing').toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) await timedInfo(request);
  expect(pings(), 'a failed check was made again on the next status requests').toEqual(afterFirst);
});

test('an empty update source is github.com', async ({ request }) => {
  test.setTimeout(120_000);
  setSettingInFile('UpgradeSource', '');
  const info = await timedInfo(request);
  expect(info.json.UpgradeSource).toBe('github.com');
  expect(info.secs, 'an empty source was checked as a custom one').toBeLessThan(5);
});
