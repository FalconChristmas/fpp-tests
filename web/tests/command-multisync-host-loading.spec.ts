import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page, Route } from '@playwright/test';

// The command editor's Multisync Hosts field, while the lists load.  Ticking
// a host loads each argument's list (Start Playlist's playlist, an overlay
// model picker) from that host, through this player's /proxy/<host>/.  The
// hosts are TEST-NET addresses nothing answers on; every request to them is
// answered here, or held, or refused.  The page gives a host 5 s.
//
// Fixed in fpp by dc1126af2: the loads were
// synchronous requests, so a host that did not answer froze the page for as
// long as the proxy waited (about 133 s), once per list; they are now
// asynchronous, wait for every host picked, and a reload that a later one
// replaced is aborted.

const INSTANT = 'api/configfile/instantCommand.json';
const LIST = 'api/playlists/playable';
const HOST = '192.0.2.77';
const HOST2 = '192.0.2.78';
const A = 'fpp-tests-ms-a';
const B = 'fpp-tests-ms-b';
const R1 = 'fpp-tests-remote-1';
const R2 = 'fpp-tests-remote-2';
// How long a host that never answers is held: past the page's 5 s, and short
// enough that the code before the fix is let go and the run ends.
const HELD_MS = 8_000;
const GONE = 12_000;

let savedInstant: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get(INSTANT);
  savedInstant = r.ok() ? await r.text() : null;
  // Two of this player's own playlists: a list to keep, and a choice other
  // than its first.
  for (const name of [A, B]) {
    const p = await request.post(`/api/playlist/${name}`, { data: { name, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} } });
    expect(p.ok(), await p.text()).toBe(true);
  }
});
test.afterEach(async ({ request }) => {
  await request.post(INSTANT, { data: Buffer.from(savedInstant ?? '{}') });
  for (const name of [A, B]) await request.delete(`/api/playlist/${name}`);
});

type Reply = (route: Route, path: string) => unknown;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const answer = (...names: string[]): Reply => (route) => route.fulfill({ json: names });
const refuse: Reply = (route) => route.abort('connectionrefused');
// A host that never answers.  The page gives up on it; the request is let go
// afterwards, so that a page that waits for it (synchronously) ends too.
const never: Reply = async (route) => { await sleep(HELD_MS); await route.abort('timedout').catch(() => {}); };
// A host that answers when the test says so (or, failing that, late).
function slow(...names: string[]) {
  let release!: () => void;
  const opened = new Promise<void>((r) => { release = r; });
  let handled!: () => void;
  const done = new Promise<void>((r) => { handled = r; });
  const reply: Reply = async (route) => {
    await Promise.race([opened, sleep(HELD_MS)]);
    await route.fulfill({ json: names }).catch(() => {});
    handled();
  };
  // Resolves once the answer has been given (or found to have nobody left).
  return { reply, open: async () => { release(); await done; } };
}

// Answers what the page asks of the hosts through /proxy/, and notes what it
// asked and which requests ended without an answer.
async function hosts(page: Page, replies: Record<string, Reply>) {
  const asked: string[] = [];
  const failed: string[] = [];
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (p.startsWith('/proxy/')) asked.push(p); });
  page.on('requestfailed', (r) => { const p = new URL(r.url()).pathname; if (p.startsWith('/proxy/')) failed.push(p); });
  await page.route(/\/proxy\/192\.0\.2\.\d+\//, (route) => {
    const [, , host, ...rest] = new URL(route.request().url()).pathname.split('/');
    return (replies[host] ?? answer())(route, rest.join('/'));
  });
  return { asked, failed };
}

async function put(request: APIRequestContext, body: unknown) {
  const r = await request.post(INSTANT, { data: Buffer.from(JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

async function open(page: Page, request: APIRequestContext, saved: Record<string, unknown>) {
  await put(request, saved);
  await page.goto('/index.php');
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toHaveValue(saved.command as string, { timeout: 15_000 });
  return dialog;
}
const startPlaylist = (name: string | null, extra: Record<string, unknown> = {}) => ({
  command: 'Start Playlist', args: name === null ? [] : [name, 'true', 'false', 'true'], ...extra,
});

const tickMultisync = (dialog: Locator) => dialog.locator('#tblCommandEditor_multisync').check();
async function addHost(dialog: Locator, host: string, options: { timeout?: number } = {}) {
  await dialog.locator('#tblCommandEditor_multisyncHostsCustom').fill(host, options);
  await dialog.locator('#tblCommandEditor_multisyncHosts_row input[value="Add"]').click(options);
}
const hostBox = (dialog: Locator, host: string) => dialog.locator(`#tblCommandEditor_multisyncHostsSelect input[value="${host}"]`);
const picker = (dialog: Locator) => dialog.locator('#tblCommandEditor_arg_1');
const values = (p: Locator) => p.locator('option').evaluateAll((os) => os.map((o: any) => o.value));
const texts = (p: Locator) => p.locator('option').evaluateAll((os) => os.map((o: any) => o.text));
const chosen = (p: Locator) => p.evaluate((s: any) => [...s.selectedOptions].map((o: any) => o.value));

test('a host that never answers leaves the page usable', async ({ page, request }) => {
  // Regression: dc1126af2.  The loads were synchronous requests: the
  // page did not respond at all, not even to Cancel, until the proxy gave up
  // on the host.
  const { asked } = await hosts(page, { [HOST]: never });
  const dialog = await open(page, request, startPlaylist(null));
  await tickMultisync(dialog);
  await addHost(dialog, HOST, { timeout: 3_000 });
  await expect.poll(() => asked.length, { timeout: 3_000 }).toBeGreaterThan(0);
  await dialog.locator('#btnCancelCommandEditor').click({ timeout: 3_000 });
  await expect(page.locator('#commandEditorPopup')).toBeHidden({ timeout: 3_000 });
});

test('a host that gives up leaves the list and the choice as they were', async ({ page, request }) => {
  // Regression: dc1126af2.  The list was emptied before the hosts' answers
  // were looked at, so a host that failed left nothing to choose from, and
  // the choice went with it.
  const { failed } = await hosts(page, { [HOST]: never });
  const dialog = await open(page, request, startPlaylist(B));
  await expect(picker(dialog)).toHaveValue(B);
  expect(await values(picker(dialog))).toEqual([A, B]);
  await tickMultisync(dialog);
  await addHost(dialog, HOST);
  await expect.poll(() => failed.length, { message: 'the page gives up on the host', timeout: GONE }).toBeGreaterThan(0);
  expect(await values(picker(dialog))).toEqual([A, B]);
  await expect(picker(dialog)).toHaveValue(B);
});

test('with one of two hosts answering, its list is used and the choice stays', async ({ page, request }) => {
  // Guard: the count of the hosts that have each name has always counted a
  // host that fails as one that lacks it.  The change must keep that, and
  // the choice, when one of two hosts does not answer.
  const { asked } = await hosts(page, { [HOST]: answer(A, R1), [HOST2]: refuse });
  const dialog = await open(page, request, startPlaylist(A));
  await tickMultisync(dialog);
  await addHost(dialog, HOST);
  await addHost(dialog, HOST2);
  await expect.poll(() => texts(picker(dialog)), { message: 'the list from the host that answered' })
    .toEqual([`${A} (exists on 1/2 Hosts)`, `${R1} (exists on 1/2 Hosts)`]);
  await expect(picker(dialog)).toHaveValue(A);
  expect(asked.some((p) => p.startsWith(`/proxy/${HOST2}/`))).toBe(true);
});

test('a slow answer for hosts no longer picked does not replace the newer list', async ({ page, request }) => {
  // Regression: dc1126af2.
  // An answer that arrives after a later pick has replaced it must not be
  // shown: the page aborts that load.
  const first = slow(R1);
  const { failed } = await hosts(page, { [HOST]: first.reply, [HOST2]: answer(R2) });
  const dialog = await open(page, request, startPlaylist(null));
  await tickMultisync(dialog);
  await addHost(dialog, HOST);
  await addHost(dialog, HOST2);
  await hostBox(dialog, HOST).uncheck();
  await expect.poll(() => values(picker(dialog)), { message: 'the list of the host still picked', timeout: GONE }).toEqual([R2]);
  await first.open();
  expect(failed.some((p) => p.startsWith(`/proxy/${HOST}/`)), 'the superseded load was aborted').toBe(true);
  expect(await values(picker(dialog))).toEqual([R2]);
});

for (const how of ['unticking the host', 'turning Multisync off']) {
  test(`${how} while its list loads ignores the answer`, async ({ page, request }) => {
    // Regression: dc1126af2.  Hosts taken away mid-load left their load
    // running, and its answer replaced this player's list.
    const late = slow(R1);
    await hosts(page, { [HOST]: late.reply });
    const dialog = await open(page, request, startPlaylist(null));
    await tickMultisync(dialog);
    await addHost(dialog, HOST);
    if (how === 'unticking the host') await hostBox(dialog, HOST).uncheck();
    else await dialog.locator('#tblCommandEditor_multisync').uncheck();
    await expect.poll(() => values(picker(dialog)), { message: "this player's list" }).toEqual([A, B]);
    await late.open();
    expect(await values(picker(dialog))).toEqual([A, B]);
  });
}

test('unticking the host after its list loaded brings this player\'s list back', async ({ page, request }) => {
  // Regression: dc1126af2.  Taking the hosts away left the list the hosts
  // had given; a name only they had could not be told from one this player
  // has.
  await hosts(page, { [HOST]: answer(R1, R2) });
  const dialog = await open(page, request, startPlaylist(null));
  await tickMultisync(dialog);
  await addHost(dialog, HOST);
  await expect.poll(() => values(picker(dialog)), { message: "the host's list" }).toEqual([R1, R2]);
  await picker(dialog).selectOption(R2);
  await hostBox(dialog, HOST).uncheck();
  await expect.poll(() => values(picker(dialog)), { message: "this player's list, and the choice only the host had" }).toEqual([A, B, R2]);
  expect(await texts(picker(dialog))).toEqual([A, B, `${R2} (not on this player)`]);
  await expect(picker(dialog)).toHaveValue(R2);
});

test('a chosen value the hosts lack stays, a default moves to the hosts\' first', async ({ page, request }) => {
  // Regression: dc1126af2.  Whatever the host did not offer was dropped,
  // the choice with it, and the list showed its first entry as if it were
  // the one chosen.  A value that was only the list's default (nobody chose
  // it) is not a choice and moves to what the host offers first.
  await hosts(page, { [HOST]: answer(R1, R2) });
  let dialog = await open(page, request, startPlaylist(B));
  await tickMultisync(dialog);
  await addHost(dialog, HOST);
  await expect.poll(() => values(picker(dialog)), { message: 'the saved choice, among the host\'s' }).toEqual([R1, R2, B]);
  expect(await texts(picker(dialog))).toEqual([R1, R2, `${B} (not on selected hosts)`]);
  await expect(picker(dialog)).toHaveValue(B);

  dialog = await open(page, request, startPlaylist(null));
  await expect(picker(dialog)).toHaveValue(A);
  await tickMultisync(dialog);
  await addHost(dialog, HOST);
  await expect(picker(dialog)).toHaveValue(R1);
});

test('a saved command whose host is down is saved as it was', async ({ page, request }) => {
  // Guard (green before the change too): reopened with its host unreachable,
  // accepting the editor must save the command with the playlist it had, not
  // one lost to an emptied list.
  await page.route('**/api/command', (route) => route.fulfill({ json: {} }));
  const { failed } = await hosts(page, { [HOST]: refuse });
  const args = [B, 'true', 'false', 'true'];
  const dialog = await open(page, request, startPlaylist(B, { multisyncCommand: true, multisyncHosts: HOST }));
  await expect.poll(() => failed.length, { message: 'the load from the host ends', timeout: GONE }).toBeGreaterThan(0);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(INSTANT));
  await dialog.locator('#btnSaveEditorCommand').click();
  expect((await sent).postDataJSON()).toEqual({ command: 'Start Playlist', args, multisyncCommand: true, multisyncHosts: HOST });
});

test('a saved empty value does not become the first option', async ({ page, request }) => {
  // Guard (green before the change too): a command saved with nothing chosen
  // must not show, or save, the first entry of the host's list.
  await page.route('**/api/command', (route) => route.fulfill({ json: {} }));
  await hosts(page, { [HOST]: answer(R1, R2) });
  const saved = { command: 'Start Playlist', args: ['', 'true', 'false', 'true'], multisyncCommand: true, multisyncHosts: HOST };
  const dialog = await open(page, request, saved);
  await expect.poll(() => values(picker(dialog)), { message: "the host's list" }).toEqual([R1, R2]);
  expect(await picker(dialog).evaluate((s: any) => s.selectedIndex)).toBe(-1);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(INSTANT));
  await dialog.locator('#btnSaveEditorCommand').click();
  expect((await sent).postDataJSON().args).toEqual(saved.args);
});

test('a choice made while the list loads is kept', async ({ page, request }) => {
  // Guard (green before the change too; the page did not respond while the
  // list loaded, so there was nothing to pick): the answer must not choose the
  // first entry over what was picked meanwhile.
  const late = slow(R1, B);
  await hosts(page, { [HOST]: late.reply });
  const dialog = await open(page, request, startPlaylist(null));
  await tickMultisync(dialog);
  await addHost(dialog, HOST);
  await picker(dialog).selectOption(B);
  await late.open();
  await expect.poll(() => values(picker(dialog)), { message: "the host's list" }).toEqual([R1, B]);
  await expect(picker(dialog)).toHaveValue(B);
});

test("saved multi-selections and a model only the host has survive the Type filter", async ({ page, request }) => {
  // Regression: dc1126af2, with the picker of 5f0d2bc23 over the hosts'
  // list.  The picker kept its own copy of the local list, so a model only
  // the host has was lost (and, with an apostrophe in its name, broke the
  // markup the filter wrote); the filter did not offer the host's models.
  const MODEL = 'fpp-tests-matrix';
  const ODD = "fpp-tests-bob's tree";
  const CELLS = 'fpp-tests-remote-cells';
  const OTHER = 'fpp-tests-remote-model';
  const level = (await (await request.get('/api/settings/uiLevel')).text()).replace(/\W/g, '');
  await request.put('/api/settings/uiLevel', { data: '3' });
  try {
    await page.route(/api\/configfile\/xlights-submodels\.json/, (route) =>
      route.fulfill({ json: { source: 'xlights', version: 1, submodels: [{ Name: CELLS }] } }));
    await hosts(page, { [HOST]: (route, path) => route.fulfill({ json: path.startsWith('api/models') ? [ODD, OTHER, CELLS] : [] }) });
    const dialog = await open(page, request, {
      command: 'Overlay Model State', args: [`${MODEL},${ODD}`, 'Enabled'], multisyncCommand: true, multisyncHosts: HOST,
    });
    const models = picker(dialog);
    const bar = dialog.locator('.ldOverlayFilter');
    await expect(bar, 'the Type selector').toBeVisible();
    const both = [MODEL, ODD].sort();
    await expect.poll(async () => (await values(models)).includes(OTHER), { message: "the host's models" }).toBe(true);
    expect((await chosen(models)).sort(), 'on open').toEqual(both);

    await bar.locator('.ldTypeFilter').selectOption('submodel');
    await expect.poll(() => values(models), { message: "the host's submodel, and what was chosen" }).toEqual(expect.arrayContaining([CELLS, ...both]));
    expect(await values(models)).not.toContain(OTHER);
    expect((await chosen(models)).sort(), 'under Submodels').toEqual(both);

    await bar.locator('.ldTypeFilter').selectOption('all');
    await expect.poll(() => values(models), { message: "every one of the host's" }).toEqual(expect.arrayContaining([OTHER, CELLS, ...both]));
    expect((await chosen(models)).sort(), 'under All').toEqual(both);
  } finally {
    await request.put('/api/settings/uiLevel', { data: level || '0' });
  }
});

test('a page opened through another player asks the hosts through that player', async ({ page, request }) => {
  // Regression: dc1126af2.  The request went to the site's /proxy/<host>/,
  // a path the player the page was opened through never serves; a page
  // opened under /proxy/<ip>/ asks relative to itself, so that its own
  // player passes it on.  The page here is the player's, served under a
  // /proxy/ path of its own.
  const VIA = '192.0.2.50';
  const asked: string[] = [];
  await put(request, startPlaylist(null));
  await page.route(new RegExp(`/proxy/${VIA}/`), (route) => {
    const url = new URL(route.request().url());
    const rest = url.pathname.slice(`/proxy/${VIA}`.length);
    if (rest.startsWith('/proxy/')) {
      asked.push(url.pathname);
      return route.fulfill({ json: [R1] });
    }
    return route.continue({ url: `${url.origin}${rest}${url.search}` });
  });
  await page.goto(`/proxy/${VIA}/index.php`);
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toHaveValue('Start Playlist', { timeout: 15_000 });
  await tickMultisync(dialog);
  await addHost(dialog, HOST);
  await expect.poll(() => asked, { message: 'asked through the player the page came from' }).toEqual([`/proxy/${VIA}/proxy/${HOST}/${LIST}`]);
  await expect.poll(() => values(picker(dialog))).toEqual([R1]);
});
