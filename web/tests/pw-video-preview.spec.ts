import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { CONFIG, cleanupPipeWire, writeFile } from './pw-helpers';

// The Video Input page's preview of a test-pattern source that is not
// running (saved disabled, so fppd has no pipeline for it): the API renders
// the pattern itself, honouring the pattern and size the page has selected
// but not saved yet, from a fixed list.
// Feature: 95e06650d.  Before it a source that wasn't running previewed only
// if it was a V4L2 device; a test pattern got a 503.

test.skip(!container, 'writes the video input config inside the run-web.sh container');

test.afterEach(cleanupPipeWire);

// Fetch a preview in the page and decode it: its size, and the colour at a
// point given as fractions of the width and height.
async function preview(page: Page, query: string, at: [number, number] = [0.05, 0.3]) {
  return page.evaluate(async ({ query, at }) => {
    const r = await fetch('/api/pipewire/video/input-sources/1/preview?' + query);
    const type = r.headers.get('Content-Type');
    if (!r.ok) return { status: r.status, type, text: (await r.text()).slice(0, 300) };
    const img = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(Math.floor(img.width * at[0]), Math.floor(img.height * at[1]), 1, 1).data;
    return { status: r.status, type, width: img.width, height: img.height, rgb: [px[0], px[1], px[2]] };
  }, { query, at });
}

const on = (v: number) => v > 160;
const off = (v: number) => v < 90;

test('a stopped test pattern previews the pattern asked for, at the size asked for', async ({ page }) => {
  writeFile(`${CONFIG}/pipewire-video-input-sources.json`, {
    videoInputSources: [{ id: 1, name: 'Bars', type: 'videotestsrc', pattern: 'smpte', enabled: false,
      width: 320, height: 240, framerate: 10, pipeWireNodeName: 'fpp_video_src_1_bars' }],
  });
  await page.goto('/pipewire-video-inputs.php');

  // The saved pattern: SMPTE bars, white-ish at the left a third of the way down.
  const saved = await preview(page, 'width=64');
  expect(saved.status, JSON.stringify(saved)).toBe(200);
  expect(saved.type).toBe('image/jpeg');
  expect([saved.width, saved.height]).toEqual([64, 48]);
  expect(saved.rgb!.every(on), `not the bars' white: ${saved.rgb}`).toBe(true);

  // An unsaved selection wins over the saved one.
  const red = await preview(page, 'width=64&pattern=red');
  expect(red.status, JSON.stringify(red)).toBe(200);
  const [r, g, b] = red.rgb!;
  expect(on(r) && off(g) && off(b), `not red: ${red.rgb}`).toBe(true);

  // A pattern not on the list -- here with pipeline syntax -- falls back to
  // the saved pattern rather than reaching gst-launch.
  const hostile = await preview(page, 'width=64&pattern=' + encodeURIComponent('red ! filesink location=/tmp/x'));
  expect(hostile.status, JSON.stringify(hostile)).toBe(200);
  expect(hostile.rgb!.every(on), `not the saved bars: ${hostile.rgb}`).toBe(true);

  // The unsaved source size sets the aspect; an absurd one is clamped.
  const wide = await preview(page, 'width=64&pattern=red&srcw=640&srch=160');
  expect([wide.width, wide.height]).toEqual([64, 16]);
  const huge = await preview(page, 'width=64&pattern=red&srcw=7680&srch=100000');
  expect(huge.status, JSON.stringify(huge)).toBe(200);
  expect([huge.width, huge.height]).toEqual([64, Math.round((64 * 4320) / 7680)]);
});
