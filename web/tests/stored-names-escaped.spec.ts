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
    // sink, with its own test below.
    await expect(status.locator('img')).toHaveCount(0);
  } finally {
    await command(request, 'Stop Now');
    await request.delete(path);
  }
});

// The status page's Playlist or Sequence dropdown built its options from the
// playlist, sequence and media names as they were, so a playlist or media file
// named with markup ran script for whoever opened the status page.  The
// command editor's lists (playlists for Start Playlist, files for others)
// did the same, or escaped only the first quote (the next test).  Regression:
// 096d367ba ("fix(security): list playlist and media names on the status page
// as text").
test('the status page lists playlist and media names as text', async ({ page, request }) => {
  const name = 'x"><img src=x onerror=window.__fppTestsPlaylistList=1>';
  const media = 'x"><img src=x onerror=window.__fppTestsMediaList=1>.mp3';
  const path = `/api/playlist/${encodeURIComponent(name)}`;
  const mediaPath = `/api/file/Music/${encodeURIComponent(media)}`;
  const pl = await request.post(path, {
    data: {
      name, version: 4, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 60 }],
    },
  });
  expect(pl.ok(), await pl.text()).toBe(true);
  try {
    expect((await request.post(mediaPath, { data: 'fpp-tests' })).ok()).toBe(true);
    await page.goto('/index.php');
    const select = page.locator('#playlistSelect');
    // Filled once the lists have loaded: the placeholder is all it has before.
    await expect(select.locator('optgroup[label="Media"]')).toHaveCount(1, { timeout: 15_000 });
    expect(await ran(page, '__fppTestsPlaylistList'), 'the playlist name ran as markup').toBeUndefined();
    expect(await ran(page, '__fppTestsMediaList'), 'the media name ran as markup').toBeUndefined();
    await expect(select.locator('img')).toHaveCount(0);
    // The control: both names are listed, whole, as the options' values.
    await expect(select.locator('option', { hasText: name })).toHaveAttribute('value', name);
    await expect(select.locator('option', { hasText: media })).toHaveAttribute('value', media);
  } finally {
    await request.delete(mediaPath);
    await request.delete(path);
  }
});

test('the command editor lists playlist names as text', async ({ page, request }) => {
  // Two quotes: one copy escaped only the first.
  const name = 'x"y"><img src=x onerror=window.__fppTestsCommandList=1>';
  const path = `/api/playlist/${encodeURIComponent(name)}`;
  const pl = await request.post(path, {
    data: {
      name, version: 4, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 60 }],
    },
  });
  expect(pl.ok(), await pl.text()).toBe(true);
  try {
    await page.goto('/commandPresets.php');
    // Both copies of the editor's argument builder, given the playlist
    // argument Start Playlist declares.
    const values = await page.evaluate(() => {
      const w = window as any;
      const arg = [{ name: 'name', type: 'string', description: 'Playlist Name', contentListUrl: 'api/playlists' }];
      const out: string[][] = [];
      for (const [id, fn] of [['fppTestsArgs', w.PrintArgInputs], ['fppTestsEditable', w.PrintArgsInputsForEditable]]) {
        document.body.insertAdjacentHTML('beforeend', `<table><tbody id='${id}'></tbody></table>`);
        fn(id, false, arg);
        out.push(Array.from(document.querySelectorAll(`#${id} option`)).map((o) => (o as HTMLOptionElement).value));
      }
      return out;
    });
    expect(await ran(page, '__fppTestsCommandList'), 'the playlist name ran as markup').toBeUndefined();
    // The control: both lists hold the name, whole.
    expect(values[0]).toContain(name);
    expect(values[1]).toContain(name);
  } finally {
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
