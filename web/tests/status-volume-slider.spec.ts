import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The status page's volume slider (index.php), and fppd's volume, which is
// what the slider sets.

const volume = async (request: APIRequestContext) => Number((await (await request.get('/api/fppd/status')).json()).volume);

let was = 0;
test.beforeEach(async ({ request }) => {
  was = await volume(request);
  await request.post('/api/system/volume', { data: { volume: 50 } });
});
test.afterEach(async ({ request }) => {
  await request.post('/api/system/volume', { data: { volume: was } });
});

async function open(page: Page, posts: number[]) {
  page.on('request', (r) => {
    if (r.method() == 'POST' && r.url().endsWith('/api/system/volume')) posts.push(Number(JSON.parse(r.postData() || '{}').volume));
  });
  await page.goto('/index.php');
  await expect(page.locator('#volume')).toHaveText('50', { timeout: 15_000 });
  const slider = page.locator('#slider');
  await expect(slider).toBeVisible();
  await expect(slider).toHaveValue('50');
  return slider;
}

test('moving the mouse over the slider sets nothing', async ({ page, request }) => {
  // Regression: effd594e1.  The slider set the volume on every mousemove
  // and touchmove over it, button down or not, so passing the pointer
  // across the slider sent the volume under it to fppd.
  const posts: number[] = [];
  const slider = await open(page, posts);
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x - 20, y);
  await page.mouse.move(box.x + box.width * 0.9, y, { steps: 10 });
  await page.mouse.move(box.x + box.width * 0.1, y, { steps: 10 });
  await page.waitForTimeout(1000);
  expect(posts).toEqual([]);
  expect(await volume(request)).toBe(50);
  await expect(page.locator('#volume')).toHaveText('50');
});

test('dragging the slider leaves fppd at the volume it shows', async ({ page, request }) => {
  // Regression: effd594e1.  The slider sent the volume on its mousemove
  // as well as on each change, and with no limit on requests in flight;
  // fppd ends at the value the slider was let go at.
  // Also 8ea08153b: SetVolume()'s answer handler called string() (no such
  // function), threw, and never cleared its in-flight flag, so after the
  // first request no other was sent and fppd stayed at the first value.
  const posts: number[] = [];
  const slider = await open(page, posts);
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 30 });
  await page.mouse.up();
  const shown = Number(await slider.inputValue());
  expect(shown).toBeGreaterThan(70);
  await expect(page.locator('#volume')).toHaveText(String(shown));
  await expect.poll(() => volume(request), { timeout: 10_000 }).toBe(shown);
  // At most one per step of the drag and one for letting go; the
  // mousemove handler sent a second for every step.
  expect(posts.length).toBeLessThanOrEqual(31);
});

test('a status update does not move the slider back while its volume is being sent', async ({ page, request }) => {
  // Regression: bc7717703.  Each status answer wrote fppd's volume into the
  // slider and the number beside it, so one arriving while a change was on
  // its way (the page polls every second) put both back to the old volume
  // until the next answer.  The status WebSocket is held open without
  // sending anything, so the page polls for its status.
  await page.routeWebSocket('**/fppdws', () => {});
  const posts: number[] = [];
  const slider = await open(page, posts);
  // Held until the two status answers are in, not for a set time: a slow
  // run polls less often, and a timed hold ran out before the second answer.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/system/volume', async (route) => {
    await held;
    await route.continue();
  });
  const status = () => page.waitForResponse((r) => /\/api\/(system|fppd)\/status/.test(r.url()));
  await slider.fill('80');
  expect(posts).toEqual([80]);
  // Two status answers, both still saying 50, come in while it is out.
  await status();
  await status();
  expect(await volume(request)).toBe(50);
  // Read once each, after the page has handled the answer: a retrying
  // expect would pass on the 80 shown before it did.
  await page.waitForTimeout(300);
  expect(await page.locator('#volume').textContent()).toBe('80');
  expect(await slider.inputValue()).toBe('80');
  release();
  await expect.poll(() => volume(request), { timeout: 10_000 }).toBe(80);
});

test('a drag let go while a volume request is still out leaves fppd at the volume shown', async ({ page, request }) => {
  // Regression: d12594b0b (found checking effd594e1).  SetVolume() dropped
  // a value outright when a request was already out, rather than sending
  // the latest one when it returned.  If the slider was let go before the
  // last request came back -- a quick drag to a player 200 ms away -- the
  // value it was let go at was never sent: fppd stayed where the first
  // request left it, and the next status put the slider back there.
  const posts: number[] = [];
  const slider = await open(page, posts);
  await page.route('**/api/system/volume', async (route) => {
    await new Promise((r) => setTimeout(r, 200));
    await route.continue();
  });
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 10 });
  await page.mouse.up();
  const shown = Number(await slider.inputValue());
  expect(shown).toBeGreaterThan(70);
  await expect.poll(() => volume(request), { timeout: 5_000 }).toBe(shown);
});
