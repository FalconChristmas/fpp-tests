import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

// Sending crash and diagnostic reports (UploadAndDeleteCrashReports() in
// fpp.js, File Manager > Crash Reports and the Diagnostic Report wizard): the
// player sends each one, or, when it can't reach the crash server, the browser
// does, once; a report is deleted from the player only after it is confirmed
// delivered, and what happened to each is said.  A report lost before it is
// delivered can't be had again.  The player's API and the crash server are
// answered by the test; nothing is sent.

// The crash server the page's CSP lets it post to; the test's route answers
// for it, so nothing leaves.
const TARGET = 'https://crashes.falconplayer.com/crashUpload/index.php';
type Answer = { status?: number; json?: unknown; abort?: boolean };

class Crashes {
  log: string[] = [];
  posts: { field: string; filename: string; size: number }[] = [];
  constructor(readonly page: Page, readonly answers: {
    upload?: Answer | ((file: string) => Answer); target?: Answer; report?: Answer; server?: Answer; del?: Answer;
  }) {}

  private async give(route: Route, a: Answer | undefined, fallback: Answer) {
    const x = a ?? fallback;
    if (x.abort) return route.abort('connectionrefused');
    return route.fulfill({ status: x.status ?? 200, json: x.json ?? {} });
  }

  async start() {
    const p = this.page;
    await p.route('**/api/crashes/disclosures', (r) => r.fulfill({ json: { rows: [], goesTo: 'FPP developers' } }));
    await p.route('**/api/crashes/upload/**', (r) => {
      const file = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()!);
      this.log.push(`player sends ${file} ${r.request().postData()}`);
      const a = typeof this.answers.upload === 'function' ? this.answers.upload(file) : this.answers.upload;
      return this.give(r, a, { json: { Status: 'OK' } });
    });
    await p.route('**/api/crashes/uploadTarget', (r) => {
      this.log.push('target');
      return this.give(r, this.answers.target, { json: { url: TARGET, field: 'crashfile' } });
    });
    await p.route('**/api/file/Crashes/**', (r) => {
      const file = decodeURIComponent(new URL(r.request().url()).pathname.replace(/.*\/api\/file\/Crashes\//, ''));
      if (r.request().method() === 'DELETE') {
        this.log.push(`delete ${file}`);
        return this.give(r, this.answers.del, { json: { status: 'OK' } });
      }
      this.log.push(`read ${file}`);
      const a = this.answers.report;
      if (a?.abort || (a?.status && a.status >= 400)) return this.give(r, a, {});
      return r.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK fpp-tests zip ' + file) });
    });
    await p.route(TARGET, (r) => {
      const body = r.request().postDataBuffer()?.toString('latin1') ?? '';
      const m = /name="([^"]+)"; filename="([^"]+)"/.exec(body);
      this.posts.push({ field: m?.[1] ?? '', filename: m?.[2] ?? '', size: body.length });
      this.log.push(`browser sends ${m?.[2]}`);
      return this.give(r, this.answers.server, { status: 200, json: { ok: true } });
    });
    await p.goto('/index.php');
    await p.waitForFunction(() => typeof (window as any).UploadAndDeleteCrashReports === 'function');
  }

  // Asks, says Yes, and waits for the results dialog: its text.
  async send(files: string[]) {
    const p = this.page;
    await p.evaluate((f) => (window as any).UploadAndDeleteCrashReports(f, {}), files);
    const ask = p.locator('#confirmUploadCrash');
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Yes', exact: true }).click();
    const done = p.locator('#dialogOKPopup');
    await expect(done).toBeVisible({ timeout: 15_000 });
    return (await done.innerText()).replace(/\s+/g, ' ');
  }
}

test('a report the player sends is deleted from it once sent', async ({ page }) => {
  const c = new Crashes(page, {});
  await c.start();
  const said = await c.send(['2026-11-01-fpp-tests.zip', '2026-11-02-fpp-tests-manual.zip']);
  expect(c.log).toEqual([
    'player sends 2026-11-01-fpp-tests.zip {"consent":true}', 'delete 2026-11-01-fpp-tests.zip',
    'player sends 2026-11-02-fpp-tests-manual.zip {"consent":true}', 'delete 2026-11-02-fpp-tests-manual.zip',
  ]);
  expect(said).toContain('2 reports were sent and removed from this player.');
});

for (const [why, upload] of [
  ['says it has no route out', { json: { Status: 'ERROR', Message: 'no route', CanRetryFromBrowser: true } }],
  ["can't be asked", { abort: true }],
] as const) {
  test(`a report the player can't send because it ${why} is sent by the browser, then deleted`, async ({ page }) => {
    const c = new Crashes(page, { upload });
    await c.start();
    const said = await c.send(['2026-11-03-fpp-tests.zip']);
    expect(c.log.slice(1)).toEqual(['target', 'read 2026-11-03-fpp-tests.zip', 'browser sends 2026-11-03-fpp-tests.zip', 'delete 2026-11-03-fpp-tests.zip']);
    // The report itself, under the field the crash server takes.
    expect(c.posts).toEqual([{ field: 'crashfile', filename: '2026-11-03-fpp-tests.zip', size: expect.any(Number) }]);
    expect(said).toContain('1 report was sent and removed from this player.');
  });
}

test('a browser send with no answer is not repeated, and the report is kept', async ({ page }) => {
  const c = new Crashes(page, { upload: { abort: true }, server: { abort: true } });
  await c.start();
  const said = await c.send(['2026-11-04-fpp-tests.zip']);
  expect(c.posts).toHaveLength(1);
  expect(c.log.filter((l) => l.startsWith('delete'))).toEqual([]);
  expect(said).toContain('1 report was sent from your browser, but no delivery confirmation came back, so it has been kept on the player.');
});

test('a crash server that refuses the report keeps it on the player, and says so', async ({ page }) => {
  const c = new Crashes(page, { upload: { abort: true }, server: { status: 413 } });
  await c.start();
  const said = await c.send(['2026-11-05-fpp-tests.zip']);
  expect(c.log.filter((l) => l.startsWith('delete'))).toEqual([]);
  expect(said).toContain('The following could not be sent; any still on the player have been kept:');
  expect(said).toContain('2026-11-05-fpp-tests.zip (server returned HTTP 413)');
});

test('a report the player refuses to send is kept, with its reason, and the others still go', async ({ page }) => {
  const c = new Crashes(page, {
    upload: (f) => (f.includes('-06-') ? { json: { Status: 'ERROR', Message: 'consent needed for <manual>' } } : { json: { Status: 'OK' } }),
  });
  await c.start();
  const said = await c.send(['2026-11-06-fpp-tests.zip', '2026-11-07-fpp-tests.zip']);
  expect(c.log).toEqual([
    'player sends 2026-11-06-fpp-tests.zip {"consent":true}',
    'player sends 2026-11-07-fpp-tests.zip {"consent":true}', 'delete 2026-11-07-fpp-tests.zip',
  ]);
  expect(said).toContain('1 report was sent and removed from this player.');
  expect(said).toContain('2026-11-06-fpp-tests.zip (consent needed for <manual>)');
});

test('a report sent but not deleted is said to be still on the player', async ({ page }) => {
  const c = new Crashes(page, { del: { status: 500, json: { status: 'ERROR' } } });
  await c.start();
  const said = await c.send(['2026-11-08-fpp-tests.zip']);
  expect(said).toContain('1 report was sent, but could not be deleted from this player; delete it from File Manager › Crash Reports.');
  expect(said).not.toContain('removed from this player');
});

test("with no upload target, or a report the browser can't read, nothing is posted and the report is kept", async ({ page }) => {
  const c = new Crashes(page, { upload: { abort: true }, target: { json: {} } });
  await c.start();
  expect(await c.send(['2026-11-09-fpp-tests.zip'])).toContain('2026-11-09-fpp-tests.zip (no upload target configured)');
  c.answers.target = undefined;
  c.answers.report = { status: 404 };
  await page.locator('#dialogOKPopup .modal-footer').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#dialogOKPopup')).toBeHidden();
  expect(await c.send(['2026-11-10-fpp-tests.zip'])).toContain('2026-11-10-fpp-tests.zip (report not found on this player)');
  expect(c.posts).toEqual([]);
  expect(c.log.filter((l) => l.startsWith('delete'))).toEqual([]);
});

test('saying No sends nothing', async ({ page }) => {
  const c = new Crashes(page, {});
  await c.start();
  const done = page.evaluate(() => new Promise((resolve) =>
    (window as any).UploadAndDeleteCrashReports(['2026-11-11-fpp-tests.zip'], { onDone: (t: unknown) => resolve(t) })));
  await page.locator('#confirmUploadCrash').getByRole('button', { name: 'No', exact: true }).click();
  expect(await done).toBeNull();
  expect(c.log).toEqual([]);
});
