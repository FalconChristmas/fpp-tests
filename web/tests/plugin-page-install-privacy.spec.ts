import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { PluginRepo, installPlugin, routePluginList } from './plugin-backfill';
import { privacyRecord, restoreState, saveState } from './plugin-repo';

// Installing and updating a plugin from the Plugins page, through its
// privacy-disclosure dialogs.  The server side of the gate (a block that was
// not the one accepted is refused) is in plugin-privacy-gate.spec.ts and
// plugin-privacy.spec.ts; this is the page around it:
//
// - Install posts the block the install dialog showed (InstallPlugin).  When
//   the clone says something else (the listing is behind the repository),
//   the stream ends with a @@PRIVACY-PENDING@@ line; the page closes the
//   progress dialog and shows the cloned block (InstallStreamDone,
//   ConfirmPrivacyChange), and Accept posts the install again with it.
// - Update asks .../privacy first, and a changed or removed block is shown
//   before anything is pulled (UpgradePlugin).
//
// The receiving end is the plugin directory and the privacy record on the
// player.  Plugins are clones of repositories inside the player
// (plugin-backfill.ts), listed to the page by the test.

test.skip(!container, 'installs plugins from repositories inside the run-web.sh container');

const RAW = 'https://raw.githubusercontent.com/fpp-tests';

const blockA = {
  summary: 'Plays a tune.', sends: [], collects: [], sensors: [], remoteAccess: 'none',
  systemChanges: [], closedCode: false, other: 'none',
};
const blockB = { ...blockA, sends: [{ what: 'play counts', to: 'stats.fpp-tests.invalid', when: 'always' }] };

const repos: PluginRepo[] = [];
function newRepo(name: string): PluginRepo {
  const r = new PluginRepo(name);
  repos.push(r);
  return r;
}

let notice = '';
test.beforeEach(async ({ request }) => {
  saveState();
  notice = String((await (await request.get('/api/settings/pluginNoticeAcknowledged')).json()).value ?? '');
  // The one-time plugin notice is plugin-list-ui.spec.ts's; skip it here.
  const major = String((await (await request.get('/api/system/info')).json()).Version).split('.')[0];
  await request.put('/api/settings/pluginNoticeAcknowledged', { data: major });
});

test.afterEach(async ({ request }) => {
  const names = repos.map((r) => r.name);
  for (const r of repos.splice(0)) r.remove();
  restoreState(names);
  await request.put('/api/settings/pluginNoticeAcknowledged', { data: notice });
});

// The page with $repo listed as $listed says (its pluginInfo.json as the
// plugin list serves it), and the card on screen.
async function openListed(page: Page, repo: PluginRepo, listed: Record<string, unknown>) {
  const url = `${RAW}/${repo.name}/master/pluginInfo.json`;
  // Listed for this FPP release, so the card offers Install.
  const major = String(await (await page.request.get('/api/system/info')).json().then((j: any) => j.Version)).split('.')[0];
  const versions = [{ minFPPVersion: `${major}.0`, maxFPPVersion: '0', branch: 'master' }];
  await routePluginList(page, [[repo.name, url]], { [url]: repo.info({ versions, ...listed }) });
  await page.goto('/plugins.php');
  await expect(page.locator(`[id="row-${repo.name}"]`).first()).toBeAttached({ timeout: 20_000 });
}

async function clickInstall(page: Page, repo: PluginRepo) {
  await page.locator(`[id="row-${repo.name}"] [data-plugin-action="install"]`).first().click();
  const dialog = page.locator('#confirmInstallDialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.modal-footer button', { hasText: /^\s*Install( anyway)?\s*$/ }).click();
}

const progress = (page: Page) => page.locator('#pluginsProgressPopup');
const changed = (page: Page) => page.locator('#confirmInstallChangedDialog');

test('Install from the page installs the plugin and records the disclosure the dialog showed', async ({ page }) => {
  const repo = newRepo('fpp-tests-pgi-plain');
  repo.init({ privacy: blockA });
  await openListed(page, repo, { privacy: blockA });
  await clickInstall(page, repo);
  await expect(progress(page)).toBeVisible();
  await expect.poll(() => repo.installed(), { timeout: 120_000 }).toBe(true);
  await expect.poll(() => privacyRecord(repo.name)?.privacy, { timeout: 30_000 }).toEqual(blockA);
  // No review: the clone said what the dialog showed.
  await expect(progress(page).locator('#modalCloseButton')).toBeEnabled({ timeout: 60_000 });
  await expect(changed(page)).toHaveCount(0);
  await expect(progress(page).locator('textarea')).not.toHaveValue(/@@PRIVACY-PENDING@@/);
});

test('a listing behind the repository: the cloned disclosure is shown, and Accept installs it', async ({ page }) => {
  const repo = newRepo('fpp-tests-pgi-behind');
  repo.init({ privacy: blockB });
  await openListed(page, repo, { privacy: blockA });
  await clickInstall(page, repo);

  const dialog = changed(page);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(progress(page)).toBeHidden();
  await expect(dialog.locator('.modal-title')).toHaveText(`Review the privacy disclosure of ${repo.name}`);
  await expect(dialog).toContainText('has a different privacy disclosure from the one shown before');
  await expect(dialog).toContainText('stats.fpp-tests.invalid');
  expect(repo.installed(), 'installed before the changed disclosure was accepted').toBe(false);
  expect(privacyRecord(repo.name)).toBeUndefined();

  await dialog.locator('.modal-footer button', { hasText: 'Accept and install' }).click();
  await expect.poll(() => repo.installed(), { timeout: 120_000 }).toBe(true);
  await expect.poll(() => privacyRecord(repo.name)?.privacy, { timeout: 30_000 }).toEqual(blockB);
  // The second attempt went in: no second review.
  await expect(progress(page).locator('#modalCloseButton')).toBeEnabled({ timeout: 60_000 });
  await expect(dialog).toBeHidden();
});

test('a listing behind the repository: Cancel on the review installs nothing and says so', async ({ page }) => {
  const repo = newRepo('fpp-tests-pgi-cancel');
  repo.init({ privacy: blockB });
  await openListed(page, repo, { privacy: blockA });
  await clickInstall(page, repo);

  const dialog = changed(page);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await dialog.locator('.modal-footer button', { hasText: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.jGrowl-message', { hasText: 'Install cancelled. Nothing was installed.' })).toBeVisible();
  expect(repo.installed()).toBe(false);
  expect(privacyRecord(repo.name)).toBeUndefined();
});

test('a listing with no disclosure, a repository with one: the review shows it as a first disclosure', async ({ page }) => {
  // The listing declares nothing, so the page posts "accepted: none"; the
  // clone declares B.  The review is the clone's block, not a "change" from
  // nothing.
  const repo = newRepo('fpp-tests-pgi-first');
  repo.init({ privacy: blockB });
  await openListed(page, repo, {});
  await clickInstall(page, repo);

  const dialog = changed(page);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog.locator('.modal-title')).toHaveText(`Review the privacy disclosure of ${repo.name}`);
  await expect(dialog).toContainText('stats.fpp-tests.invalid');
  await expect(dialog.locator('del, s, .text-decoration-line-through')).toHaveCount(0);
  await dialog.locator('.modal-footer button', { hasText: 'Accept and install' }).click();
  await expect.poll(() => repo.installed(), { timeout: 120_000 }).toBe(true);
  await expect.poll(() => privacyRecord(repo.name)?.privacy, { timeout: 30_000 }).toEqual(blockB);
});

// An installed plugin, accepted at $installed, whose upstream now says $now;
// the page open on its details with Update offered.
async function updateOffered(page: Page, request: any, repo: PluginRepo, now: Record<string, unknown>) {
  repo.init({ privacy: blockA });
  const r = await installPlugin(request, repo.info({ privacy: blockA, privacyAccepted: blockA }));
  expect(r.Status, JSON.stringify(r)).toBe('OK');
  const before = repo.installedHead();
  const tip = repo.setInfo(now, 'changed');
  await routePluginList(page);
  await page.goto('/plugins.php');
  await expect(page.locator(`[id="row-${repo.name}"]`).first()).toBeAttached({ timeout: 20_000 });
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
  await page.locator(`[id="row-${repo.name}"] .pluginTitle`).first().click();
  await expect(page.locator('#pluginDetailDialog')).toBeVisible();
  await page.locator('#pluginDetailCheckBtn').click();
  const update = page.locator('#pluginDetailDialog button', { hasText: /^\s*Update\s*$/ });
  await expect(update).toBeVisible({ timeout: 60_000 });
  return { before, tip, update };
}

test('Update with a changed disclosure shows the change first; Cancel leaves the plugin, Accept lands and records it', async ({ page, request }) => {
  const repo = newRepo('fpp-tests-pgu-changed');
  const { before, tip, update } = await updateOffered(page, request, repo, { privacy: blockB });
  await update.click();

  const dialog = page.locator('#confirmUpgradeDialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.modal-title')).toHaveText(`This update changes the privacy disclosure of ${repo.name}`);
  await expect(dialog).toContainText('stats.fpp-tests.invalid');
  await dialog.locator('.modal-footer button', { hasText: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(progress(page)).toBeHidden();
  expect(repo.installedHead(), 'Cancel updated the plugin').toBe(before);
  expect(privacyRecord(repo.name)?.privacy).toEqual(blockA);

  await page.evaluate((n) => (window as any).UpgradePlugin(n), repo.name);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.locator('.modal-footer button', { hasText: 'Accept changes and update' }).click();
  await expect.poll(() => repo.installedHead(), { timeout: 120_000 }).toBe(tip);
  await expect.poll(() => privacyRecord(repo.name)?.privacy, { timeout: 30_000 }).toEqual(blockB);
});

test('Update to a version with no disclosure says the disclosure is removed', async ({ page, request }) => {
  const repo = newRepo('fpp-tests-pgu-removed');
  const { before, update } = await updateOffered(page, request, repo, {});
  await update.click();

  const dialog = page.locator('#confirmUpgradeDialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.modal-title')).toHaveText(`This update removes the privacy disclosure of ${repo.name}`);
  await expect(dialog).toContainText('has no privacy disclosure');
  await dialog.locator('.modal-footer button', { hasText: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(repo.installedHead()).toBe(before);
});
