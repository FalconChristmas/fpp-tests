import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// When a call from the UI fails, the error dialog carries what the server (or
// the browser) said about it: the response body when there is one, otherwise
// the request's own fields, each cut at 200 characters.  show_details() in
// fpp.js builds that text and every playlist, command and power call appends it.

const dialog = (page: Page, title: string) =>
  page.locator('.ui-dialog, .modal.show').filter({ hasText: title }).first();

test('a failed playlist save and list load show the server\'s reply in the error dialog', async ({ page }) => {
  // Regression: a81d3458e.  These errors said only "Unable to save playlist"
  // and the like, leaving no way to tell a full disk from a bad name; the
  // response body is now appended.  (The delete path has since moved into
  // playlists.php with its own wording.)
  const body = 'details-from-server-4f2a';
  const fail = (route: any) => route.fulfill({ status: 500, contentType: 'text/plain', body });
  await page.route((u) => u.pathname === '/api/playlist/error-details-pl', fail);
  await page.route((u) => u.pathname === '/api/playlists/validate', fail);

  await page.goto('/playlists.php');
  await page.evaluate(() => (window as any).GetPlaylistArray());
  await expect(dialog(page, 'Error loading list of playlists')).toContainText(body, { timeout: 15_000 });
  await expect(dialog(page, 'Error loading list of playlists')).toContainText('Load Playlists');
  await page.evaluate(() => (window as any).SavePlaylistAs('error-details-pl'));
  await expect(dialog(page, 'Unable to save playlist')).toContainText(body);
});

test('a failed call with no reply body shows the request fields, cut at 200 characters', async ({ page }) => {
  // Regression: cbcb0f92f.  show_details() for an error with no responseText
  // (a dropped connection) listed each argument as "type: json"; the first
  // version used a lookbehind regex Safari rejects, and its replacement left a
  // console.log(arg) after the loop, where arg was out of scope, so this path
  // threw a ReferenceError instead of showing the dialog.
  await page.goto('/index.php');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route((u) => u.pathname === '/api/command', (route) => route.abort('connectionreset'));
  await page.evaluate(() => (window as any).RunCommandJSON({ command: 'Volume Set', args: ['50'] }));
  const d = dialog(page, 'api/command call failed');
  await expect(d).toContainText('object: ');
  await expect(d).toContainText('string: "error"');
  expect(errors).toEqual([]);

  // A long argument is cut: nothing after 200 characters of it is shown.
  const text = await page.evaluate(() => {
    const long = { filler: 'x'.repeat(500), tail: 'END-MARKER' };
    return (window as any).show_details([long]);
  });
  expect(text).toContain(' ...');
  expect(text).not.toContain('END-MARKER');
  expect(text.length).toBeLessThan(300);
});
