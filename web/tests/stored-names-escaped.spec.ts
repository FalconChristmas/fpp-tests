import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// File names come from whoever named the file, and quotes and angle brackets
// are legal in them; playlist and command preset names are stored as given.  Several pages put them into markup, attributes
// or <script> unescaped, and the site CSP allows inline script.  Fixed in fpp
// 9abdda210 ("fix(security): escape file names and other stored values where
// pages render them").
//
// Each case stores a value that sets a global if it ever runs as markup or
// script, loads the page that shows it, and checks that it was shown as text.

async function ran(page: Page, flag: string) {
  return page.evaluate((f) => (window as any)[f], flag);
}

async function command(request: APIRequestContext, name: string, args: string[] = []) {
  return request.post('/api/command', { data: { command: name, args } });
}

test('the status page shows a running playlist name as text', async ({ page, request }) => {
  const name = '<img src=x onerror=window.__fppTestsPlaylist=1>';
  const path = `/api/playlist/${encodeURIComponent(name)}`;
  const pl = await request.post(path, {
    data: {
      name, version: 4, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 60 }],
    },
  });
  expect(pl.ok(), await pl.text()).toBe(true);
  try {
    await command(request, 'Start Playlist', [name, 'false', 'false']);
    await expect.poll(async () => (await (await request.get('/api/fppd/status')).json()).current_playlist?.playlist,
      { timeout: 15_000 }).toBe(name);

    await page.goto('/index.php');
    const status = page.locator('#schedulerStatus');
    await expect(status).toContainText(name, { timeout: 15_000 });
    // Only the status line is checked: the page's playlist list is another
    // sink, still unescaped at the time of writing.
    await expect(status.locator('img')).toHaveCount(0);
  } finally {
    await command(request, 'Stop Now');
    await request.delete(path);
  }
});

test('the testing page lists a sequence name as text', async ({ page, request }) => {
  const name = 'x"><img src=x onerror=window.__fppTestsSequence=1>.fseq';
  const path = `/api/file/Sequences/${encodeURIComponent(name)}`;
  expect((await request.post(path, { data: 'fpp-tests' })).ok()).toBe(true);
  try {
    await page.goto('/testing.php');
    await expect(page.locator('#selSequence option', { hasText: name })).toHaveAttribute('value', name);
    expect(await ran(page, '__fppTestsSequence')).toBeUndefined();
  } finally {
    await request.delete(path);
  }
});

test('the channel outputs page embeds command preset names as data', async ({ page, request }) => {
  const original = await (await request.get('/api/configfile/commandPresets.json')).text();
  const presets = JSON.parse(original);
  presets.commands = [...(presets.commands ?? []),
    { name: '</script><img src=x onerror=window.__fppTestsPreset=1>', command: 'Stop Now', args: [] }];
  try {
    const w = await request.post('/api/configfile/commandPresets.json', { data: JSON.stringify(presets) });
    expect(w.ok(), await w.text()).toBe(true);
    await page.goto('/channeloutputs.php');
    await page.waitForFunction(() => typeof (window as any).commandPresets === 'object');
    expect(await page.evaluate(() => (window as any).commandPresets.commands.map((c: any) => c.name)))
      .toContain('</script><img src=x onerror=window.__fppTestsPreset=1>');
    expect(await ran(page, '__fppTestsPreset')).toBeUndefined();
  } finally {
    await request.post('/api/configfile/commandPresets.json', { data: Buffer.from(original) });
  }
});
