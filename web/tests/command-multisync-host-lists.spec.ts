import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The command editor's Multisync Hosts field.  An argument that offers a
// list (Start Playlist's playlist) fills it from the machine the command
// will run on; choosing a host loads the list from that host, through the
// player's /proxy/.

const INSTANT = 'api/configfile/instantCommand.json';
const HOST = '192.0.2.77';

let saved: string | null = null;
test.beforeEach(async ({ request }) => {
  const r = await request.get(INSTANT);
  saved = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post(INSTANT, { data: Buffer.from(saved ?? '{}') });
});

async function put(request: APIRequestContext, body: unknown) {
  const r = await request.post(INSTANT, { data: Buffer.from(JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

test('choosing a Multisync host reloads the playlist list from that host', async ({ page, request }) => {
  // Regression: b75bed628.  The Hosts field was only a value to save: the
  // argument lists (playlists, presets) kept showing the local machine's
  // names after a different target was chosen, so a name that exists only on
  // the remote could not be picked.
  await put(request, { command: 'Start Playlist', args: [] });
  // The request must go to the page's own origin, port included (the suite's
  // player is published on a port other than 80, and the page's CSP refuses
  // any other origin); the request the page makes is what is checked, not an
  // answer to it.  Fixed by 6931d749a: the request went to http://host, no
  // port, and the CSP blocked it.
  const asked: string[] = [];
  const origins: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/proxy/')) { asked.push(u.pathname); origins.push(u.origin); }
  });
  await page.goto('/index.php');
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toHaveValue('Start Playlist', { timeout: 15_000 });
  expect(asked, 'nothing asked of the host before it is chosen').toEqual([]);

  await dialog.locator('#tblCommandEditor_multisync').check();
  await dialog.locator('#tblCommandEditor_multisyncHostsCustom').fill(HOST);
  await dialog.locator('#tblCommandEditor_multisyncHosts_row input[value="Add"]').click();
  await expect(dialog.locator('#tblCommandEditor_multisyncHosts')).toHaveValue(HOST);
  await expect.poll(() => asked.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(asked.every((p) => p === `/proxy/${HOST}/api/playlists/playable`), asked.join(',')).toBe(true);
  const own = new URL(page.url()).origin;
  expect(own, 'the control: the player is not on port 80').toMatch(/:\d+$/);
  expect(origins.every((o) => o === own), `${origins.join(',')} is not ${own}`).toBe(true);
});
