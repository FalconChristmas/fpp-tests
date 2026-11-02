import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The PipeWire mixer dialog's layout (www/js/pipewire-mixer.js and the
// .pw-mixer rules of fpp.css), rendered from a model of the graph as
// pw-mixer.spec.ts does: the container has no PipeWire.

async function mixer(page: Page, groups: { name: string; cards: string[] }[]) {
  await page.route(/\/api\/(pipewire\/|system\/volume)/, (r) =>
    r.request().method() === 'GET' ? r.fallback() : r.fulfill({ json: { status: 'OK' } }));
  await page.goto('/about.php');
  await page.evaluate(() => localStorage.removeItem('pwMixerOpenSections'));
  await page.addScriptTag({ url: '/js/pipewire-mixer.js' });
  await page.evaluate((groups) => {
    document.body.insertAdjacentHTML('beforeend',
      "<input id='slider' type='range' value='100'><div id='pwMixerBody' style='width:100%'></div>");
    const w = window as any;
    w.pwMixer.data = {
      groups: groups.map((g, i) => ({ id: i + 1, name: g.name, enabled: true, volume: 100, mute: false,
        members: g.cards.map((c) => ({ cardId: c, volume: 100 })) })),
      inputGroups: [], routing: [], slots: [{ slot: 1, status: 'idle', nodeName: 'fppd_stream_1' }],
      slotVolumes: {}, nodeStates: {}, entities: {},
    };
    w.PWMixerRender(true);
  }, groups);
}

test('an output group and its cards are one block: counted, nested, and a lone card as wide as the group', async ({ page }) => {
  // Regression: 8d9875536.  Group and card strips were one flat list, so a
  // group holding a single card read as two separate outputs, side by side in
  // a two-column row.
  await page.setViewportSize({ width: 1400, height: 900 });
  await mixer(page, [{ name: 'Yard', cards: ['CardA'] }, { name: 'House', cards: ['CardB', 'CardC'] }]);
  const groups = page.locator('.pw-mixer-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).locator('.pw-mixer-sublabel').first()).toHaveText('Group · 1 output');
  await expect(groups.nth(1).locator('.pw-mixer-sublabel').first()).toHaveText('Group · 2 outputs');
  // The cards are inside their group, behind the group's own strip.
  await expect(groups.nth(0).locator('.pw-mixer-strip')).toHaveCount(2);
  await expect(groups.nth(1).locator('.pw-mixer-strip')).toHaveCount(3);
  await expect(page.locator('#pwm_member_0_0').locator('xpath=ancestor::*[contains(@class,"pw-mixer-group")]')).toHaveCount(1);
  // The lone card spans its group's row, not half of it.
  const lone = await page.locator('.pw-mixer-group').nth(0).locator('.pw-mixer-strips > .pw-mixer-strip').boundingBox();
  const holder = await page.locator('.pw-mixer-group').nth(0).locator('.pw-mixer-strips').boundingBox();
  expect(lone!.width).toBeGreaterThan(holder!.width * 0.95);
  // The two cards of the other group share its row.
  const [a, b] = await Promise.all([0, 1].map((i) => page.locator('.pw-mixer-group').nth(1).locator('.pw-mixer-strips > .pw-mixer-strip').nth(i).boundingBox()));
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + 1);
  // The section says groups and outputs separately.
  await expect(page.locator('#pwMixerBody')).toContainText('2 groups · 3 outputs');
});

test('the mixer does not scroll sideways on a phone and stacks the fader under its name', async ({ page }) => {
  // Regression: cd5d0af5d.  Bootstrap's d-flex !important on the strip
  // holder beat the grid that decides strips per row, and a strip's name,
  // fader and buttons in one line overflowed a phone's width.
  await page.setViewportSize({ width: 375, height: 800 });
  await mixer(page, [{ name: 'Yard Speakers And More', cards: ['usb-Generic_Very_Long_Card_Name'] }]);
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await over()).toBeLessThanOrEqual(1);
  const slider = page.locator('#pwm_member_0_0');
  const strip = page.locator('.pw-mixer-strip', { has: slider });
  const sb = await strip.boundingBox();
  const fb = await slider.boundingBox();
  const lb = await strip.locator('.pw-mixer-strip-label').boundingBox();
  // Stacked: the fader sits under the name, inside the strip.
  expect(fb!.y).toBeGreaterThan(lb!.y + lb!.height - 2);
  expect(fb!.x + fb!.width).toBeLessThanOrEqual(sb!.x + sb!.width + 1);
});

test('two cards in a group share a row from 1200px and stack below it', async ({ page }) => {
  // Regression: cd5d0af5d (the strips per row).
  await page.setViewportSize({ width: 1400, height: 900 });
  await mixer(page, [{ name: 'Yard', cards: ['CardA', 'CardB'] }]);
  const cols = async () => page.evaluate(() => {
    const e = document.querySelector('.pw-mixer-group > .pw-mixer-strips') as HTMLElement;
    return getComputedStyle(e).gridTemplateColumns.split(' ').length;
  });
  expect(await cols()).toBe(2);
  await page.setViewportSize({ width: 1000, height: 900 });
  expect(await cols()).toBe(1);
});
