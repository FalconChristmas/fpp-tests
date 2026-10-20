import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, docker, inPlayer } from './container';

// An FPP or OS update was visible only in the browser tab that started it:
// another tab, a refresh or another device showed nothing, and two starters
// could run updates over each other.  Fixed in fpp b03dc7a24 ("fix(updates):
// Persistent FPP update progress across refresh and devices (#3070)"):
//   - an update holds media/tmp/fpp-update.lock, and a second starter is
//     refused;
//   - /api/system/updateActivity reads the run from
//     logs/fpp_system_upgrades.log (its START, stage and FINISH lines), and
//     every page shows a banner while one is in progress;
//
// None of this runs a real update: on a tree without the fix, the update
// pages would pull and build in the test player.

const MEDIA = '/home/fpp/media';
const LOG = `${MEDIA}/logs/fpp_system_upgrades.log`;

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

function logLine(text: string) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `${now} [fpp-update master] ${text}\n`;
}

function appendLog(text: string) {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/logs && printf '%s' "$1" >> ${LOG}`, 'sh', text);
}

async function activity(request: APIRequestContext) {
  const r = await request.get('/api/system/updateActivity');
  expect(r.status(), 'no updateActivity route').toBe(200);
  return r.json();
}

test('a second update is refused while one holds the lock', async ({ request }) => {
  const lock = `${MEDIA}/tmp/fpp-update.lock`;
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/tmp && touch ${lock} && chmod 666 ${lock}`);
  // Held by another process for the length of the test, as a running update holds it.
  docker('exec', '-d', container, 'flock', '-n', lock, 'sleep', '37');
  try {
    await expect.poll(() => inPlayer('sh', '-c', `flock -n ${lock} true && echo free || echo held`).trim(),
      { timeout: 5_000 }).toBe('held');
    const r = await request.post('/upgradeOS.php?wrapped=1&os=fpp-tests-missing.fppos', { timeout: 30_000 });
    expect(await r.text()).toContain('Another FPP update is already running');
  } finally {
    // [s]: so the pattern does not match this shell's own command line.
    inPlayer('sh', '-c', 'pkill -f "[s]leep 37" || true');
  }
});

test('an update in progress is reported from its log, and so is its failure', async ({ page, request }) => {
  inPlayer('rm', '-f', LOG);
  try {
    appendLog(logLine('===== fpp-update START: master =====') + logLine('===== Building FPP ====='));
    const running = await activity(request);
    expect(running.inProgress).toBe(true);
    expect(running.stage).toBe('Building FPP');

    await page.goto('/index.php');
    await expect(page.locator('#updateInProgressFlag')).toBeVisible({ timeout: 15_000 });

    appendLog(logLine('===== fpp-update FINISH: master (rc=2) ====='));
    const done = await activity(request);
    expect(done.inProgress).toBe(false);
    expect(done.failed).toBe(true);
  } finally {
    inPlayer('rm', '-f', LOG);
  }
});

// The idle payload was cached only when the log had content, so with the log
// missing (a player never updated from the UI), empty (after logrotate) or
// holding no START marker, every status poll forked ps for the worker probe:
// four processes per poll, from every open page and MultiSync peer.
// Regression: bb8bf8233 ("fix(updates): cache the idle update state when the
// upgrade log is missing or empty").
//
// ps is wrapped, for the length of the test, by a script that counts its
// calls.
test('an idle player does not fork ps on every poll', async ({ request }) => {
  const ps = inPlayer('sh', '-c', 'command -v ps').trim();
  const count = '/tmp/fpp-tests-ps-count';
  inPlayer('sh', '-c', `mv ${ps} ${ps}.fpp-tests && printf '#!/bin/sh\\necho >> ${count}\\nexec ${ps}.fpp-tests "$@"\\n' > ${ps} && chmod 755 ${ps}`);
  const calls = () => parseInt(inPlayer('sh', '-c', `cat ${count} 2>/dev/null | wc -l`).trim(), 10);
  const states: Record<string, () => void> = {
    missing: () => inPlayer('rm', '-f', LOG),
    empty: () => inPlayer('sh', '-c', `mkdir -p ${MEDIA}/logs && : > ${LOG}`),
    'without a START': () => { inPlayer('rm', '-f', LOG); appendLog(logLine('fpp-tests: not a run')); },
  };
  try {
    for (const [state, stage] of Object.entries(states)) {
      stage();
      // The first poll works it out, and may probe; the rest are served from
      // the cache.
      expect((await activity(request)).inProgress).toBe(false);
      const before = calls();
      for (let i = 0; i < 5; i++) {
        const a = await activity(request);
        expect(a.inProgress, `${state}: ${JSON.stringify(a)}`).toBe(false);
      }
      expect(calls() - before, `ps calls over 5 more polls, log ${state}`).toBe(0);
    }
    // The control: the wrapper counts.
    const before = calls();
    inPlayer('ps', 'ax');
    expect(calls() - before).toBe(1);
  } finally {
    inPlayer('sh', '-c', `mv ${ps}.fpp-tests ${ps}; rm -f ${count} ${LOG}`);
  }
});
