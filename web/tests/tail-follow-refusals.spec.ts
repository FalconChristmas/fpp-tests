import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// GET /api/file/Logs/tailfollow/<log> streams a log as it grows
// (www/api/controllers/files.php TailFollowFile; the stream itself is in
// filemanager-actions.spec.ts).  It runs `tail -f` on a path built from the
// request, so what it refuses matters: a link out of the logs folder, a
// folder, a name that is not there.  "var/log/<file>" is the one way out, to
// the system's own logs.

test.skip(!container, 'seeds logs and links inside the run-web.sh container');

const LOGS = `${MEDIA}/logs`;
const SYS = '/var/log/fpp-tests-tail-refusals.log';

const clean = () => inPlayer('sh', '-c', `rm -rf -- "${LOGS}"/fpp-tests-tail-refusals* "${SYS}"`);
test.beforeEach(() => {
  clean();
  putFile(`${LOGS}/fpp-tests-tail-refusals.log`, 'in the logs folder\n');
  inPlayer('ln', '-s', `${MEDIA}/settings`, `${LOGS}/fpp-tests-tail-refusals-link.log`);
  inPlayer('ln', '-s', `${LOGS}/fpp-tests-tail-refusals.log`, `${LOGS}/fpp-tests-tail-refusals-inside.log`);
  inPlayer('mkdir', '-p', `${LOGS}/fpp-tests-tail-refusals-dir.log`);
  putFile(SYS, 'a system log line\n');
});
test.afterEach(clean);

// The stream's first data lines (it never ends by itself).
async function firstData(page: Page, name: string): Promise<{ status: number; type: string | null; lines: string[] }> {
  await page.goto('/filemanager.php');
  return page.evaluate(async (url) => {
    const ctl = new AbortController();
    const r = await fetch(url, { signal: ctl.signal });
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const until = Date.now() + 2500;
    while (Date.now() < until && !text.includes('\n\n')) {
      const t = setTimeout(() => ctl.abort(), until - Date.now());
      try {
        const { value, done } = await reader.read();
        clearTimeout(t);
        if (done) break;
        text += dec.decode(value);
      } catch {
        break;
      }
    }
    ctl.abort();
    return {
      status: r.status, type: r.headers.get('content-type'),
      lines: text.split('\n').filter((l) => l.startsWith('data: ') && l.length > 6).map((l) => l.slice(6)),
    };
  }, `/api/file/Logs/tailfollow/${name}`);
}

test('a link that leads out of the logs folder is refused, and its target is not sent', async ({ request }) => {
  const r = await request.get('/api/file/Logs/tailfollow/fpp-tests-tail-refusals-link.log', { timeout: 10_000 });
  expect(r.status()).toBe(403);
  expect(await r.text()).toBe('Invalid file path.');
});

test('a folder, and a name that is not there, are refused', async ({ request }) => {
  let r = await request.get('/api/file/Logs/tailfollow/fpp-tests-tail-refusals-dir.log', { timeout: 10_000 });
  expect(r.status()).toBe(404);
  expect(await r.text()).toBe('File not found: fpp-tests-tail-refusals-dir.log');
  r = await request.get('/api/file/Logs/tailfollow/fpp-tests-tail-refusals-none.log', { timeout: 10_000 });
  expect(r.status()).toBe(403);
  expect(await r.text()).toBe('Invalid file path.');
  // The system-log prefix does not reach outside /var/log either.
  r = await request.get('/api/file/Logs/tailfollow/var/log/fpp-tests-tail-refusals-none.log', { timeout: 10_000 });
  expect(r.status()).toBe(403);
});

test('a log, a link to a log in the folder, and a system log by its var/log/ name are streamed', async ({ page }) => {
  for (const [name, line] of [
    ['fpp-tests-tail-refusals.log', 'in the logs folder'],
    ['fpp-tests-tail-refusals-inside.log', 'in the logs folder'],
    ['var/log/fpp-tests-tail-refusals.log', 'a system log line'],
  ]) {
    const got = await firstData(page, name);
    expect(got.status, name).toBe(200);
    expect(got.type, name).toContain('text/event-stream');
    expect(got.lines, name).toEqual([line]);
  }
});

test('a line count that is not one starts from the last line', async ({ page }) => {
  putFile(`${LOGS}/fpp-tests-tail-refusals.log`, 'one\ntwo\nthree\n');
  for (const lines of ['0', '-4', 'many']) {
    expect((await firstData(page, `fpp-tests-tail-refusals.log?lines=${lines}`)).lines, lines).toEqual(['three']);
  }
});
