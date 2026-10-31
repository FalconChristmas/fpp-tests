import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';

// The Troubleshooting page's tabs and what each command shows: a tab per
// command group, whose commands troubleshootingHelper.php runs when the tab
// is opened, and links to each command's heading that a reload or a shared
// address comes back to.

test.skip(!container, 'runs the troubleshooting commands inside the run-web.sh container');

// The keys of the commands the page has asked troubleshootingHelper.php for.
function helperKeys(page: Page): string[] {
  const keys: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/troubleshootingHelper.php') keys.push(u.searchParams.get('key') ?? '');
  });
  return keys;
}

test('a link to a command\'s heading opens its tab, runs it and shows it', async ({ page }) => {
  // Regression: c96ba818d.  The page always opened on its first tab: a link
  // (or a reload) to a command's heading in another tab showed the wrong
  // tab, with the command not run.  Regression: 8c4544d84.  fpp.js took any
  // address hash for a tab's and showed the tab it named; a heading's isn't
  // one, and the lookup threw before the page had set up its tabs.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const keys = helperKeys(page);
  // The commands answer after the page's own settling (a scroll to the top
  // 50 ms after it shows the tab), as on a player whose commands take a
  // moment; each answer scrolls the heading back into view.
  await page.route('**/troubleshootingHelper.php?*', async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  // The last command of the OS tab, under the kernel's module list.
  await page.goto('/troubleshooting.php#header_ImageConfigVersion');
  await expect(page.locator('#pills-OS-tab')).toHaveClass(/active/);
  await expect(page.locator('#pills-OS')).toBeVisible();
  await expect(page.locator('#pills-Networking')).toBeHidden();
  await expect(page.locator('#command_ImageConfigVersion')).not.toContainText('Loading', { timeout: 30_000 });
  await expect(page.locator('#command_KernelModules')).not.toContainText('Loading', { timeout: 30_000 });
  await expect(page.locator('h3:has(#status_ImageConfigVersion)')).toBeInViewport();
  expect(keys).toContain('ImageConfigVersion');
  expect(errors).toEqual([]);
});

test('the open tab is in the address, so a reload comes back to it', async ({ page }) => {
  // Regression: c96ba818d.  Only <a> tabs put themselves in the address;
  // this page's tabs are buttons, so a reload went back to the first tab.
  await page.goto('/troubleshooting.php');
  await expect(page.locator('#pills-Networking-tab')).toHaveClass(/active/);
  await page.locator('#pills-DateTime-tab').click();
  await expect(page.locator('#pills-DateTime')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('#pills-DateTime');

  const keys = helperKeys(page);
  await page.reload();
  await expect(page.locator('#pills-DateTime-tab')).toHaveClass(/active/);
  await expect(page.locator('#pills-DateTime')).toBeVisible();
  await expect(page.locator('#command_Date')).toHaveText(/\d{4}/, { timeout: 30_000 });
  expect(keys).toContain('Date');
});

test('a tab\'s commands run when it is opened, not all at page load', async ({ page }) => {
  // Feature: 4606e313b.  Every command of every tab ran as the page loaded:
  // a slow first view, and outputs already stale by the time a tab was
  // looked at.
  const keys = helperKeys(page);
  await page.goto('/troubleshooting.php');
  await expect(page.locator('#command_Interfaces')).not.toContainText('Loading', { timeout: 30_000 });
  // The first tab's commands, and only those.
  expect(keys).toContain('Interfaces');
  await page.waitForTimeout(2_000);
  for (const other of ['Date', 'Memory', 'Processes', 'OSVersion']) {
    expect(keys, `${other} ran before its tab was opened`).not.toContain(other);
  }
  await page.locator('#pills-MemoryCPU-tab').click();
  await expect(page.locator('#command_Memory')).toContainText('Mem:', { timeout: 30_000 });
  expect(keys).toContain('Memory');
  expect(keys).not.toContain('Date');
});

test('each command shows what it is for and what it runs', async ({ page }) => {
  // Feature: 13d7bd4d7.  The command's description from
  // troubleshoot-commands.json goes under its heading.
  const json = await (await page.request.get('/troubleshoot-commands.json')).json();
  const fs = json.CommandGroups.Disk.commands.Filesystems;
  expect(fs.description).not.toBe('');
  await page.goto('/troubleshooting.php#pills-Disk');
  const pane = page.locator('#pills-Disk');
  await expect(pane).toBeVisible();
  await expect(pane).toContainText(`Command Description: ${fs.description}`);
  await expect(pane).toContainText(`Command: ${fs.cmd}`);
});

test('a command still running shows the loading spinner', async ({ page }) => {
  // Regression: a8b40b8ea.  68eff2708 added the spinner as
  // <img scr="www/images/loading_spinner.gif">: no src, and a path that is
  // not under the web root, so it was a broken image.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/troubleshootingHelper.php?key=Interfaces', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/troubleshooting.php');
  const spinner = page.locator('#command_Interfaces img');
  await expect(spinner).toBeVisible();
  await expect.poll(() => spinner.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  release();
  await expect(spinner).toHaveCount(0, { timeout: 30_000 });
});

test('troubleshootingHelper.php answers with the command\'s output alone, as text', async ({ request }) => {
  // Regression: 5766db2ef.  The helper loaded config.php without
  // $skipJSsettings, so every output came after config.php's <script> of
  // settings -- in the page's <pre> and in what the API returned.
  const r = await request.get('/troubleshootingHelper.php?key=Date');
  expect(r.headers()['content-type']).toMatch(/^text\/plain/);
  const text = await r.text();
  expect(text).not.toContain('<script');
  expect(text).not.toContain('settings[');
  expect(text.trim()).toMatch(/^\S.*\d{4}$/);
  expect(text.trim().split('\n')).toHaveLength(1);
});

test('a command\'s [[name]] is the helper\'s PHP variable of that name', async ({ request }) => {
  // Feature: 02e0419c2.  [[fppDir]] in Plugin History's command line is
  // fpp's directory: without the substitution php was asked to run
  // "[[fppDir]]/scripts/plugin_history.php", which does not exist.
  const r = await request.get('/troubleshootingHelper.php?key=PluginHistory', { timeout: 60_000 });
  const text = await r.text();
  expect(text).not.toContain('[[');
  expect(text).not.toContain('Could not open input file');
  expect(text).not.toBe('Failed to return valid result');
  expect(text.trim()).not.toBe('');
});

test('command output is wrapped at 160 columns, not 80', async ({ request }) => {
  // Regression: 685317293.  fold -w 80 broke every longer line (mount
  // options, process command lines) in two.
  const text = await (await request.get('/troubleshootingHelper.php?key=Mounts')).text();
  const widths = text.split('\n').map((l) => l.length);
  expect(Math.max(...widths), text).toBeGreaterThan(80);
  expect(Math.max(...widths), text).toBeLessThanOrEqual(160);
});
