import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { PLUGINS, sh } from './plugin-repo';
import { routePluginsPage } from './plugins-page';

// A plugin's own pages (plugin.php), the page the Plugin Manager opens for
// it, and its icon.  The plugins are directories put in the player's plugins
// folder, as an install leaves them, with no repository behind them: nothing
// here installs, updates or goes to GitHub.

test.skip(!container, 'puts plugins in the run-web.sh container');

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function putPlugin(name: string, files: Record<string, string | Buffer>) {
  sh(`rm -rf '${PLUGINS}/${name}' && mkdir -p '${PLUGINS}/${name}'`);
  for (const [path, content] of Object.entries(files)) {
    const b64 = Buffer.from(content).toString('base64');
    sh(`mkdir -p "$(dirname '${PLUGINS}/${name}/${path}')" && echo '${b64}' | base64 -d > '${PLUGINS}/${name}/${path}'`);
  }
}

const info = (name: string) => JSON.stringify({
  name, repoName: name, author: 'fpp-tests', description: 'fpp-tests plugin',
  versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master', sha: '' }],
});

const WITH_ICON = 'fpp-tests-icon';
const NO_ICON = 'fpp-tests-noicon';
const OLD_MENU = 'fpp-tests-oldmenu';
const NAMES = [WITH_ICON, NO_ICON, OLD_MENU];

test.beforeEach(() => {
  // The template's way of declaring a menu: 'page' => in $menuEntries.
  const menu = `<?php\n$menuEntries = Array(\n  Array('text' => 'Status', 'type' => 'status', 'page' => 'status.php', 'wrap' => 1),\n);\n` +
    `foreach ($menuEntries as $menuEntry) {\n  if ($menu == $menuEntry['type']) echo "<li><a href='plugin.php?plugin=$plugin&page=" . $menuEntry['page'] . "'>" . $menuEntry['text'] . "</a></li>\\n";\n}\n?>\n`;
  putPlugin(WITH_ICON, {
    'pluginInfo.json': info(WITH_ICON), 'icon.png': PNG, 'menu.inc': menu,
    'status.php': '<div id="fpp-tests-status">fpp-tests status page</div>\n',
  });
  putPlugin(NO_ICON, { 'pluginInfo.json': info(NO_ICON) });
  // An older plugin's status_menu.inc: plain markup, and a page without the
  // FPP header ('wrap' => 0), whose link carries nopage=1.
  putPlugin(OLD_MENU, {
    'pluginInfo.json': info(OLD_MENU),
    'status_menu.inc': `<li><a href="plugin.php?_menu=status&plugin=${OLD_MENU}&page=status.php&nopage=1">Old Menu</a></li>\n`,
    'status.php': '<div id="fpp-tests-old-status">fpp-tests old status page</div>\n',
  });
});

test.afterEach(() => sh(`cd ${PLUGINS} && rm -rf ${NAMES.join(' ')}`));

test('a plugin page is a standards-mode document with the plugin icon by its title', async ({ page, request }) => {
  // Regression: a10a8e162 ("restructure HTML document setup for proper
  // DOCTYPE handling").  config.php's comment and settings script went out
  // ahead of the DOCTYPE, and the browser drew the page in quirks mode.
  const url = `/plugin.php?plugin=${WITH_ICON}&page=status.php`;
  const body = await (await request.get(url)).text();
  expect(body.trimStart().slice(0, 40), 'something comes before the DOCTYPE').toMatch(/^<!DOCTYPE html>/i);
  await page.goto(url);
  await expect(page.locator('#fpp-tests-status')).toBeVisible();
  expect(await page.evaluate(() => document.compatMode)).toBe('CSS1Compat');
  // Feature: 7e7da6940 ("Add plugin icon displayed beside plugin title").
  // The icon is the plugin's icon.png, as the icon API serves it.
  const icon = page.locator('h1.title img.pluginIcon');
  await expect(icon).toHaveAttribute('src', new RegExp(`^api/plugin/${WITH_ICON}/icon\\?t=\\d+$`));
  await expect.poll(() => icon.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
  await expect(page.locator('h1.title')).toContainText(WITH_ICON);
  // The control: one without an icon has none.
  await page.goto(`/plugin.php?plugin=${NO_ICON}&page=status.php`);
  await expect(page.locator('h1.title')).toContainText(NO_ICON);
  await expect(page.locator('h1.title img.pluginIcon')).toHaveCount(0);
});

test('the plugin icon is served from icon.png and revalidated, not cached for a day', async ({ request }) => {
  // Feature: 384dd92d9 ("Add plugin icons with initials fallback").
  const r = await request.get(`/api/plugin/${WITH_ICON}/icon`);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('image/png');
  expect(Buffer.compare(await r.body(), PNG)).toBe(0);
  expect((await request.get(`/api/plugin/${NO_ICON}/icon`)).status()).toBe(404);
  // Regression: 72e49964d ("Bust browser cache for plugin icon updates").
  // An icon was cached for a day, so a plugin update's new icon did not show.
  expect(r.headers()['cache-control']).toContain('must-revalidate');
  const lastModified = r.headers()['last-modified'];
  expect(lastModified).toBeTruthy();
  const again = await request.get(`/api/plugin/${WITH_ICON}/icon`, { headers: { 'If-Modified-Since': lastModified } });
  expect(again.status()).toBe(304);
  // A new icon.png (as an update brings) is sent again.
  sh(`touch -d '+1 minute' '${PLUGINS}/${WITH_ICON}/icon.png'`);
  // (php-fpm can see the old mtime for a moment.)
  await expect.poll(async () => (await request.get(`/api/plugin/${WITH_ICON}/icon`, { headers: { 'If-Modified-Since': lastModified } })).status(),
    { timeout: 10_000 }).toBe(200);
  // Feature: 454a5c3b8 ("404 icon cleanup"): the plugin's info says whether
  // it has an icon, so the page does not ask for one that is not there.
  expect((await (await request.get(`/api/plugin/${WITH_ICON}`)).json()).hasIcon).toBe(true);
  expect((await (await request.get(`/api/plugin/${NO_ICON}`)).json()).hasIcon).toBe(false);
});

test('an installed plugin card shows its icon, or its initials when it has none', async ({ page, baseURL }) => {
  // Feature: 384dd92d9.  Regression: 454a5c3b8: a plugin without an icon
  // asked for one anyway and logged a 404 for it.
  await routePluginsPage(page, baseURL!, []);
  // The real icon API, not the stand-in 404.
  await page.unroute(/\/api\/plugin\/[^/]+\/icon/);
  const asked: string[] = [];
  page.on('request', (q) => { if (/\/api\/plugin\/[^/]+\/icon/.test(q.url())) asked.push(new URL(q.url()).pathname); });
  await page.goto('/plugins.php');
  await page.waitForFunction((n) => n.every((r: string) => ((window as any).installedPlugins || []).includes(r)), [WITH_ICON, NO_ICON]);
  await page.evaluate(() => (window as any).ShowTopTab('installed'));
  const withIcon = page.locator(`#installedGrid [id="row-${WITH_ICON}"]`);
  await expect.poll(() => withIcon.locator('img.pluginIcon').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { timeout: 15_000 }).toBe(1);
  const noIcon = page.locator(`#installedGrid [id="row-${NO_ICON}"]`);
  await expect(noIcon.locator('img.pluginIcon')).toHaveCount(0);
  await expect(noIcon.locator('.pluginIconFallback')).toBeVisible();
  await expect(noIcon.locator('.pluginIconFallback')).toHaveText('FT');
  expect(asked).not.toContain(`/api/plugin/${NO_ICON}/icon`);
});

test('the page a plugin opens is its status page, read from its menu', async ({ page, request, baseURL }) => {
  // Feature: 37d0348c5 ("Add \"Open\" button for installed plugins").
  // Regression: 2a24b7f9f ("improve raw-text scan and HTML extraction for
  // menu pages").  An old-style menu's link with nopage=1 was read as the
  // page "1".
  for (const name of [WITH_ICON, OLD_MENU]) {
    const r = await (await request.get(`/api/plugin/${name}/page`)).json();
    expect(r, name).toMatchObject({ found: true, page: 'status.php', url: `plugin.php?plugin=${name}&page=status.php` });
  }
  // The receiving end: plugin.php serves that page.
  const served = await (await request.get(`/plugin.php?plugin=${OLD_MENU}&page=status.php`)).text();
  expect(served).toContain('fpp-tests old status page');
  // And the installed card's Open goes there.
  await routePluginsPage(page, baseURL!, []);
  await page.goto('/plugins.php');
  await page.waitForFunction((n) => ((window as any).installedPlugins || []).includes(n), WITH_ICON);
  await page.evaluate(() => (window as any).ShowTopTab('installed'));
  const open = page.locator(`#installedGrid [id="row-${WITH_ICON}"] a`, { hasText: 'Open' });
  await expect(open).toBeVisible({ timeout: 15_000 });
  await expect(open).toHaveAttribute('href', `plugin.php?plugin=${WITH_ICON}&page=status.php`);
  await page.goto(`/${await open.getAttribute('href')}`);
  await expect(page.locator('#fpp-tests-status')).toBeVisible();
});
