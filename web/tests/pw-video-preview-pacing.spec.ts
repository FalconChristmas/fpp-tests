import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { CONFIG, cleanupPipeWire, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The Video Input page's live preview is a polled still.  It paces itself
// on a fixed period (10fps ceiling) instead of sleeping a flat 500ms after
// each frame, and it stops asking for frames while the preview is scrolled
// out of view.  The preview endpoint is stubbed here so the test sees the
// request cadence the page produces.
// Regression: 5ffe268b8.  The preview polled at 500ms + round-trip (about
// 1.8fps) and kept fetching frames nobody could see.

test.skip(!container, 'writes the video input config inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  // The page configures sources only in Advanced (Full PipeWire) mode.
  setSettingInFile('MediaBackend', 'pipewire');
});
test.afterEach(() => {
  cleanupPipeWire();
  restoreSettings();
});

// 1x1 PNG, a valid image for the page's probe <img>.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function openWithStub(page: Page, delayMs: number): Promise<number[]> {
  writeFile(`${CONFIG}/pipewire-video-input-sources.json`, {
    videoInputSources: [{ id: 1, name: 'Bars', type: 'videotestsrc', pattern: 'smpte', enabled: false,
      width: 320, height: 240, framerate: 10, pipeWireNodeName: 'fpp_video_src_1_bars' }],
  });
  const hits: number[] = [];
  await page.route('**/api/pipewire/video/input-sources/1/preview*', async route => {
    hits.push(Date.now());
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await page.goto('/pipewire-video-inputs.php');
  await page.locator('#videoPreviewBtn1').click();
  return hits;
}

test('the preview polls near 10fps rather than 500ms after each frame', async ({ page }) => {
  const hits = await openWithStub(page, 0);
  await page.waitForTimeout(2500);
  // A flat 500ms sleep gives about 5 requests in 2.5s; the fixed 100ms
  // period gives 20+.  Allow slack for a loaded runner.
  expect(hits.length, `requests in 2.5s: ${hits.length}`).toBeGreaterThan(14);
});

test('the preview stops fetching while it is scrolled out of view', async ({ page }) => {
  const hits = await openWithStub(page, 0);
  await expect(page.locator('#videoPreviewImg1')).toBeVisible();
  // Push the preview far below the viewport and scroll past it.
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '6000px';
    document.getElementById('videoPreviewImg1')!.closest('.row')!.before(spacer);
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);  // let an in-flight tick or idle re-check settle
  const before = hits.length;
  await page.waitForTimeout(2500);
  // Idle re-check is 1s and draws nothing; no frame request may go out.
  expect(hits.length - before, 'requests while scrolled away').toBe(0);

  // Scrolling it back into view resumes the polling.
  await page.evaluate(() => document.getElementById('videoPreviewImg1')!.scrollIntoView());
  await expect.poll(() => hits.length - before, { timeout: 5000 }).toBeGreaterThan(2);
});
