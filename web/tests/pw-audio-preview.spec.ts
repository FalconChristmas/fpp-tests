import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { readFile, standInCommand } from './pw-helpers';

// The mixer's audition of an output: GET /api/pipewire/audio/preview?node=
// streams a node's monitor (parec piped into ffmpeg) as MP3 until the client
// goes away, a different output is asked for, or 120 s pass.  parec and
// ffmpeg are stand-ins (a tone generator and cat), so what is checked is the
// process group the API starts and the lock file naming it, which the next
// request signals.

test.skip(!container, 'streams a preview with stand-in parec/ffmpeg inside the run-web.sh container');

const LOCK = '/home/fpp/media/tmp/pipewire-preview.pid';
const STAND_INS = ['/usr/local/bin/parec', '/usr/local/bin/ffmpeg'];

test.beforeEach(() => {
  standInCommand('parec', 'while :; do echo 0123456789abcdef; sleep 0.1; done');
  standInCommand('ffmpeg', 'cat');
  inPlayer('sh', '-c', `mkdir -p "$(dirname ${LOCK})"; rm -f ${LOCK}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `pkill -x curl; for g in $(cut -d' ' -f1 ${LOCK} 2>/dev/null); do kill -TERM -- -$g; done; ` +
    `pkill -x parec; rm -f ${LOCK} ${STAND_INS.join(' ')} /tmp/fpp-tests-parec.log /tmp/fpp-tests-ffmpeg.log /tmp/fpp-tests-prev-*.mp3; true`);
});

// A client holding a preview of `node` open, writing what it gets to a file.
function listen(node: string, out: string) {
  inPlayer('sh', '-c', `nohup curl -s -N 'http://localhost/api/pipewire/audio/preview?node=${node}' -o ${out} >/dev/null 2>&1 &`);
}

// The process group the lock file names for `node`, once it does.
async function groupOf(node: string): Promise<number> {
  await expect.poll(() => readFile(LOCK).trim(), { timeout: 15_000 }).toMatch(new RegExp(`^\\d+ ${node}$`));
  return parseInt(readFile(LOCK), 10);
}

// How many processes are in the group.
function members(pgid: number): number {
  return parseInt(inPlayer('sh', '-c', `cat /proc/[0-9]*/stat 2>/dev/null | awk '$5 == ${pgid}' | wc -l`).trim(), 10);
}

const size = (path: string) => parseInt(inPlayer('sh', '-c', `wc -c < ${path} 2>/dev/null || echo 0`).trim(), 10);

test('a second request for the same output leaves its preview stream running', async () => {
  // Regression: 848d21ed9.  A media element opens more than one request for a
  // source (a fetch, then a ranged or retried one), and each request killed
  // the stream before it: the element's second request tore down the one its
  // first was playing, so the preview never played in a browser (curl, which
  // asks once, never showed it).
  listen('fpp_tests_a', '/tmp/fpp-tests-prev-1.mp3');
  const first = await groupOf('fpp_tests_a');
  await expect.poll(() => size('/tmp/fpp-tests-prev-1.mp3'), { timeout: 10_000 }).toBeGreaterThan(0);
  listen('fpp_tests_a', '/tmp/fpp-tests-prev-2.mp3');
  await expect.poll(() => size('/tmp/fpp-tests-prev-2.mp3'), { timeout: 10_000 }).toBeGreaterThan(0);

  expect(members(first), 'the first request\'s stream was stopped by the second').toBeGreaterThan(0);
  const before = size('/tmp/fpp-tests-prev-1.mp3');
  await expect.poll(() => size('/tmp/fpp-tests-prev-1.mp3'), { timeout: 10_000 }).toBeGreaterThan(before);
});

test('asking for another output stops the previous stream and all it started', async () => {
  // Regression: 848d21ed9.  "Only one preview at a time" never worked: the
  // lock held $$, which under setsid is not the group leader, and GNU timeout
  // puts its child in a group of its own, so signalling the recorded id named
  // a group holding neither parec nor ffmpeg and the old stream played on.
  listen('fpp_tests_a', '/tmp/fpp-tests-prev-1.mp3');
  const first = await groupOf('fpp_tests_a');
  expect(members(first), 'the stream has parec, ffmpeg and the shell in its group').toBeGreaterThanOrEqual(3);

  listen('fpp_tests_b', '/tmp/fpp-tests-prev-2.mp3');
  const second = await groupOf('fpp_tests_b');
  expect(second).not.toBe(first);
  await expect.poll(() => members(first), { timeout: 15_000, message: 'the first stream is still running' }).toBe(0);
  expect(members(second), 'the new stream was stopped with the old one').toBeGreaterThanOrEqual(3);
  const before = size('/tmp/fpp-tests-prev-1.mp3');
  await new Promise((r) => setTimeout(r, 1500));
  expect(size('/tmp/fpp-tests-prev-1.mp3'), 'the first client still gets data').toBe(before);
});
