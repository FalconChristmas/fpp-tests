import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The framebuffer model a Virtual Matrix output creates for its device, on
// the Pixel Overlay Models page.

async function keep(request: APIRequestContext, file: string) {
  const r = await request.get(`/api/channel/output/${file}`);
  return r.ok() ? await r.text() : null;
}

async function restore(request: APIRequestContext, file: string, before: string | null) {
  await request.post(`/api/channel/output/${file}`, {
    data: Buffer.from(before ?? '{"channelOutputs": []}'),
  });
}

test("a Virtual Matrix's framebuffer model with no pixel size shows its channels and a pixel size of 1", async ({ page, request }) => {
  // Regression: 28a9d7033. The model a Virtual Matrix saved by the Channel
  // Outputs page creates has no PixelSize (the page saves none), and the
  // models table divided the model's size by it: NaN channels, and a Pixel
  // Size box showing nothing. (The rest of that commit, a "=" for "==" in
  // FrameBuffer::FBCopyData()'s direct-draw branch, which nothing calls with
  // draw set, and printf()s turned into debug logging, changes nothing seen.)
  const name = 'FB - fb1';
  const before = await keep(request, 'co-other');
  try {
    const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
      type: 'VirtualMatrix', enabled: 1, startChannel: 1, channelCount: 64 * 32 * 3,
      modelName: '', invert: false, flipHorizontal: false, device: 'fb1', width: 64, height: 32,
    }] } });
    expect(r.ok(), await r.text()).toBe(true);
    // fppd re-reads the outputs file when it changes, creating the model
    await expect.poll(async () => (await (await request.get('/api/overlays/models')).json())
      .filter((m) => m.Name === name).map((m) => m.PixelSize ?? 'none'),
      { message: `the ${name} model`, timeout: 15_000 }).toEqual(['none']);
    await page.goto('/pixeloverlaymodels.php');
    const row = page.locator(`#channelMemMapsAutoCreate tbody tr:has(input.blk[value="${name}"])`);
    await expect(row.locator('td.channels')).toHaveText(String(64 * 32 * 3));
    await expect(row.locator('input.pixelSize')).toHaveValue('1');
  } finally {
    await restore(request, 'co-other', before);
  }
});
