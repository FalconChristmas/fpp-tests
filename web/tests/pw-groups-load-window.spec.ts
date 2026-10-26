import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Regression: c60cef80c.  The PipeWire group pages (audio output groups, input
// mixing, video output groups, video input sources) showed Add and Save
// before the saved groups had answered.  The page's list starts empty, so a
// group added in that window was replaced when the saved ones arrived (the
// list showed only those, under a "not saved yet" banner for a group that was
// gone), and a Save there wrote the empty list over the saved groups.  The
// saved groups' request is held here until after the click, so the window is
// always there.

test.skip(!container, 'seeds config files inside the run-web.sh container');

const SAVED = 'fpp-tests Saved';

const PAGES = [
  {
    page: 'pipewire-audio.php', api: '/api/pipewire/audio/groups', file: 'pipewire-audio-groups.json',
    saved: { groups: [{ id: 1, name: SAVED, enabled: true, channels: 2, members: [] }] },
    add: 'Add Group', names: '.group-name-input', list: (j: any) => j.groups,
  },
  {
    page: 'pipewire-input-mixing.php', api: '/api/pipewire/audio/input-groups', file: 'pipewire-input-groups.json',
    saved: { inputGroups: [{ id: 1, name: SAVED, enabled: true, channels: 2, outputs: [], members: [] }] },
    add: 'Add Input Group', names: '.ig-name-input', list: (j: any) => j.inputGroups,
  },
  {
    page: 'pipewire-video.php', api: '/api/pipewire/video/groups', file: 'pipewire-video-groups.json',
    saved: { videoOutputGroups: [{ id: 1, name: SAVED, enabled: true, members: [] }] },
    add: 'Add Group', names: '.group-name-input', list: (j: any) => j.videoOutputGroups,
  },
  {
    page: 'pipewire-video-inputs.php', api: '/api/pipewire/video/input-sources', file: 'pipewire-video-input-sources.json',
    saved: { videoInputSources: [{ id: 1, name: SAVED, enabled: false, type: 'videotestsrc', pattern: 'smpte', width: 320, height: 240, framerate: 10 }] },
    add: 'Add Source', names: '.source-name-input', list: (j: any) => j.videoInputSources,
  },
];

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  // The pages edit groups only in Advanced (Full PipeWire) mode.
  setSettingInFile('MediaBackend', 'pipewire');
});
test.afterEach(() => {
  cleanupPipeWire();
  inPlayer('rm', '-f', `${CONFIG}/pipewire-video-groups.json`);
  restoreSettings();
});

// Holds the page's GET of the saved groups until release(); requested
// resolves once the page has asked for them.
async function holdGroups(page: Page, api: string) {
  let requested!: () => void, release!: () => void;
  const asked = new Promise<void>((r) => { requested = r; });
  const released = new Promise<void>((r) => { release = r; });
  await page.route((url) => url.pathname === api, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    requested();
    await released;
    await route.continue();
  });
  return { asked, release };
}

for (const p of PAGES) {
  test.describe(p.page, () => {
    test.beforeEach(() => writeFile(`${CONFIG}/${p.file}`, p.saved));

    test('a group added while the saved ones load is not lost', async ({ page }) => {
      const held = await holdGroups(page, p.api);
      await page.goto(`/${p.page}`);
      await held.asked;
      // A page that cannot take the add yet refuses the click.
      await page.getByRole('button', { name: p.add, exact: true }).first().click({ timeout: 2_000 }).catch(() => undefined);
      held.release();

      const names = page.locator(p.names);
      await expect(names.first()).toHaveValue(SAVED, { timeout: 15_000 });
      const shown = await names.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
      // Either the add waited for the saved groups or it was refused: never a
      // banner for a group the list no longer has.
      await expect(page.locator('#unsavedChangesBanner'), `the list is ${JSON.stringify(shown)}`)
        .toHaveCount(shown.length > 1 ? 1 : 0);
    });

    test('a Save while the saved groups load does not overwrite them', async ({ page }) => {
      const held = await holdGroups(page, p.api);
      await page.goto(`/${p.page}`);
      await held.asked;
      const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === p.api,
        { timeout: 3_000 }).catch(() => null);
      await page.getByRole('button', { name: 'Save', exact: true }).first().click({ timeout: 2_000 }).catch(() => undefined);
      await posted;
      // The receiving end: what is on disk, which the page and the apply read.
      const onDisk = p.list(JSON.parse(readFile(`${CONFIG}/${p.file}`))) ?? [];
      expect(onDisk.map((g: any) => g.name), 'the saved groups were overwritten').toEqual([SAVED]);
      held.release();
      await expect(page.locator(p.names).first()).toHaveValue(SAVED, { timeout: 15_000 });
    });
  });
}
