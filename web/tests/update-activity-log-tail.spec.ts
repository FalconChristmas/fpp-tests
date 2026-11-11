import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The update progress window's log (GET /api/system/updateActivity?logTail=1
// &lines=N): the run's own lines from logs/fpp_system_upgrades.log, from its
// START on, or the last N of them when the run is longer than that.  The log
// is written here; no update runs.

const LOG = '/home/fpp/media/logs/fpp_system_upgrades.log';

test.skip(!container, 'writes the upgrade log inside the run-web.sh container');

test.afterEach(() => {
  inPlayer('rm', '-f', LOG);
});

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const line = (text: string, tag = 'fpp-update master') => `${stamp()} [${tag}] ${text}`;
const work = (n: number, from = 1) => Array.from({ length: n }, (_, i) => line(`building step ${from + i}`));

function writeLog(lines: string[], ending = '\n') {
  inPlayer('mkdir', '-p', '/home/fpp/media/logs');
  putFile(LOG, lines.join(ending) + ending);
}

async function tail(request: APIRequestContext, query = '') {
  const r = await request.get(`/api/system/updateActivity?logTail=1${query}`);
  expect(r.status()).toBe(200);
  return r.json();
}

test('the log shown is the running update\'s, from its START line', async ({ request }) => {
  const earlier = [line('===== fpp-update START: master ====='), ...work(5), line('===== fpp-update FINISH: master (rc=0) =====')];
  const run = [line('===== fpp-update START: master (again) ====='), line('===== Building FPP ====='), ...work(8, 100)];
  writeLog([...earlier, ...run]);
  const a = await tail(request);
  expect(a.inProgress).toBe(true);
  expect(a.logTail).toBe(run.join('\n') + '\n');
});

test('a run longer than the lines asked for shows its last lines, whole', async ({ request }) => {
  const run = [line('===== fpp-update START: master ====='), ...work(40)];
  writeLog(run);
  expect((await tail(request, '&lines=10')).logTail).toBe(run.slice(-10).join('\n') + '\n');
  // Nothing asked for is 200 lines, which is the whole of this run.
  expect((await tail(request)).logTail).toBe(run.join('\n') + '\n');
});

test('the lines asked for are held between 1 and 500', async ({ request }) => {
  const run = [line('===== fpp-update START: master ====='), ...work(700)];
  writeLog(run);
  for (const [asked, given] of [['0', 1], ['-5', 1], ['abc', 1], ['500', 500], ['501', 500], ['100000', 500]] as [string, number][]) {
    expect((await tail(request, `&lines=${asked}`)).logTail, asked).toBe(run.slice(-given).join('\n') + '\n');
  }
});

test('the last lines of a log of several megabytes come back exact', async ({ request }) => {
  // Read from the end in growing pieces: the first piece (64 KB) holds only
  // a few of these long lines, and its first is cut in two.
  const long = (i: number) => line(`submodule chatter ${i} ` + 'x'.repeat(20_000));
  const run = [line('===== fpp-update START: master ====='), ...Array.from({ length: 150 }, (_, i) => long(i)), ...work(3)];
  writeLog(run);
  expect((await tail(request, '&lines=12')).logTail).toBe(run.slice(-12).join('\n') + '\n');
  // More than the megabyte it reads at most: what fits, from a line's start.
  const most = (await tail(request, '&lines=400')).logTail as string;
  const got = most.split('\n').slice(0, -1);
  expect(got.length).toBeGreaterThan(40);
  expect(got.length).toBeLessThan(150);
  expect(got).toEqual(run.slice(-got.length));
});

test('a log with Windows line ends, blank lines at its end, or no final line break still ends on its last line', async ({ request }) => {
  const run = [line('===== fpp-update START: master ====='), ...work(6)];
  writeLog(run, '\r\n');
  expect((await tail(request, '&lines=3')).logTail).toBe(run.slice(-3).join('\n') + '\n');

  inPlayer('mkdir', '-p', '/home/fpp/media/logs');
  putFile(LOG, run.join('\n') + '\n\n\n');
  expect((await tail(request, '&lines=3')).logTail).toBe(run.slice(-3).join('\n') + '\n');

  putFile(LOG, run.join('\n'));
  expect((await tail(request, '&lines=3')).logTail).toBe(run.slice(-3).join('\n') + '\n');
});

test('an OS upgrade taken over by its second stage is shown from its first START', async ({ request }) => {
  const tag = 'os-upgrade FPP-v9.9.fppos';
  const run = [
    line('===== os-upgrade START: FPP-v9.9.fppos =====', tag), line('downloading', tag),
    line('===== os-upgrade START: FPP-v9.9.fppos (part 1) =====', tag), line('unpacking', tag),
  ];
  writeLog([line('===== fpp-update START: master ====='), line('===== fpp-update FINISH: master (rc=0) ====='), ...run]);
  const a = await tail(request);
  expect(a.op).toBe('os-upgrade');
  expect(a.logTail).toBe(run.join('\n') + '\n');
});

test('with no log there is nothing to show, and no update', async ({ request }) => {
  inPlayer('rm', '-f', LOG);
  const a = await tail(request);
  expect(a.inProgress).toBe(false);
  expect(a.logTail ?? '').toBe('');
});
