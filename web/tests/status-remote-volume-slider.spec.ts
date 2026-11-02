import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA } from './settings-file';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The status page (index.php) of a player in remote mode: its volume
// slider, and the menu when the Other outputs file has no outputs list.

test.skip(!container, "edits the player's settings file");

const volume = async (request: APIRequestContext) => Number((await (await request.get('/api/fppd/status')).json()).volume);

async function openRemote(page: Page) {
  await page.routeWebSocket('**/fppdws', () => {});
  await page.route(/\/api\/(system|fppd)\/status/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.mode = 8;
    json.mode_name = 'remote';
    return route.fulfill({ response, json });
  });
  await page.goto('/index.php');
  await expect(page.locator('#remoteModeInfo')).toBeVisible({ timeout: 15_000 });
}

test('the remote view\'s volume slider sets fppd\'s volume', async ({ page, request }) => {
  // Guards a51936e82 (#1132): the remote slider was wired with the jQuery UI
  // slider's stop callback, which a plain range input never fires, so
  // moving it changed nothing in fppd.  Not red on its own revert: the
  // input's oninput (effd594e1) now sends the volume too.
  const was = await volume(request);
  try {
    await request.post('/api/system/volume', { data: { volume: 50 } });
    await keepingSettings(async () => {
      setSettingInFile('fppMode', 'remote');
      await openRemote(page);
      const slider = page.locator('#remoteVolumeSlider');
      await expect(slider).toBeVisible();
      await slider.fill('73');
      await expect(page.locator('#remoteVolume')).toHaveText('73');
      await expect.poll(() => volume(request), { timeout: 10_000 }).toBe(73);
    });
  } finally {
    await request.post('/api/system/volume', { data: { volume: was } });
  }
});

test('an Other outputs file with no outputs list logs no PHP warning for the menu', async ({ page, request }) => {
  // Regression: a51936e82.  menu.inc looped over the file's channelOutputs
  // without checking it was there, so a file holding {} logged a warning
  // from every page's menu.
  const LOG = `${MEDIA}/logs/apache2-error.log`;
  const logged = () => Number(inPlayer('sh', '-c', `grep -c 'foreach() argument must be of type array|object, null given in .*menu.inc' ${LOG} 2>/dev/null || true`).trim() || 0);
  const r = await request.get('/api/channel/output/co-other');
  const before = r.ok() ? await r.text() : null;
  try {
    await request.post('/api/channel/output/co-other', { data: Buffer.from('{}') });
    const was = logged();
    const res = await page.goto('/index.php');
    const body = await res!.text();
    expect(body).toContain('navbarDropdownMenuLinkStatus');
    expect(body).not.toContain('virtualdisplaywrapper.php');
    await page.waitForTimeout(500);
    expect(logged() - was, inPlayer('sh', '-c', `tail -3 ${LOG} 2>/dev/null || true`)).toBe(0);
  } finally {
    await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
  }
});
