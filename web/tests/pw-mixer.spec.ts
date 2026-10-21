import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The PipeWire mixer dialog's rendering (www/js/pipewire-mixer.js), driven
// with a model of the graph instead of a live one: the container has no
// PipeWire.  The script is the page's own, loaded into an ordinary page with
// the two elements it reads (#slider, the page's master, and #pwMixerBody);
// every write it makes is answered here and goes nowhere.

async function mixer(page: Page) {
  await page.route(/\/api\/(pipewire\/|system\/volume)/, (r) =>
    r.request().method() === 'GET' ? r.fallback() : r.fulfill({ json: { status: 'OK' } }));
  await page.goto('/about.php');
  await page.evaluate(() => localStorage.removeItem('pwMixerOpenSections'));
  await page.addScriptTag({ url: '/js/pipewire-mixer.js' });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend',
      "<input id='slider' type='range' value='100'><div id='pwMixerBody'></div>");
  });
}

// Render the dialog from a model: one output group with one card, and the
// given entity states.  force: false is a poll's redraw.
async function render(page: Page, o: { group?: number; member?: number; master?: number; entities?: object; mute?: boolean; force?: boolean }) {
  await page.evaluate((o) => {
    const w = window as any;
    w.$('#slider').val(o.master ?? 100);
    w.pwMixer.data = {
      groups: [{ id: 1, name: 'Yard', enabled: true, volume: o.group ?? 100, mute: !!o.mute,
        members: [{ cardId: 'Card1', volume: o.member ?? 100 }] }],
      inputGroups: [], routing: [], slots: [{ slot: 1, status: 'idle', nodeName: 'fppd_stream_1' }],
      slotVolumes: {}, nodeStates: {}, entities: o.entities ?? {},
    };
    w.PWMixerRender(o.force ?? true);
  }, o);
}

const fader = (page: Page, id: string) => page.locator(`#${id}`);

test('a fader holds a value just set against a stale poll, and follows a change made elsewhere', async ({ page }) => {
  // Regression: 40446fe84. A value set in the mixer was pinned for three
  // seconds against whatever the server reported, so a change made anywhere
  // else (the API, a playlist, another browser) did not show until then.
  await mixer(page);
  await render(page, { group: 50 });
  await page.evaluate(() => {
    const el = document.getElementById('pwm_group_0') as HTMLInputElement;
    el.value = '30';
    (window as any).PWMixerSlide(el, 'pwm_group_0');
  });
  // A poll that left before the write landed still says 50: keep showing 30.
  await render(page, { group: 50 });
  await expect(fader(page, 'pwm_group_0')).toHaveValue('30');
  // Someone else set 55: follow it at once.
  await render(page, { group: 55 });
  await expect(fader(page, 'pwm_group_0')).toHaveValue('55');
});

test('a drag that never saw its pointer released stops holding up redraws', async ({ page }) => {
  // Regression: 2777befd5. Redraws were skipped while any drag was marked,
  // and only a pointerup on the slider itself cleared the mark: released
  // anywhere else, it froze every later redraw for the life of the dialog.
  // Also: output group and card faders ran to 150 while every other went to 100.
  await mixer(page);
  await render(page, { group: 50 });
  await expect(fader(page, 'pwm_group_0')).toHaveAttribute('max', '100');
  await expect(fader(page, 'pwm_member_0_0')).toHaveAttribute('max', '100');
  await page.evaluate(() => {
    const w = window as any;
    w.PWMixerDragStart('pwm_group_0');
    // ... and its pointer released off the slider, four seconds ago.
    w.pwMixer.dragging['pwm_group_0'] = Date.now() - 4000;
  });
  await render(page, { group: 70, force: false });
  await expect(fader(page, 'pwm_group_0')).toHaveValue('70');
});

test('output strips show their level once the master is applied', async ({ page }) => {
  // Feature: fb8059517. The master attenuates at the card sink, so it never
  // moves the group faders; each strip says what its own level becomes.
  await mixer(page);
  await render(page, { master: 50, group: 80, member: 50 });
  const group = page.locator('.pw-mixer-strip', { has: page.locator('#pwm_group_0') });
  await expect(group.locator('.pw-mixer-eff')).toHaveText('→40%');
  const member = page.locator('.pw-mixer-strip', { has: page.locator('#pwm_member_0_0') });
  await expect(member.locator('.pw-mixer-eff')).toHaveText('→20%');
  // At unity nothing is added.
  await render(page, { master: 100, group: 100, member: 100 });
  await expect(page.locator('.pw-mixer-eff')).toHaveCount(0);
});

test('mute and listen buttons say what they will do, and to which channel', async ({ page }) => {
  // Feature: 3f493510e.
  await mixer(page);
  await render(page, {});
  const group = page.locator('.pw-mixer-strip', { has: page.locator('#pwm_group_0') });
  await expect(group.getByRole('button', { name: 'Mute Yard' })).toHaveAttribute('title', 'Mute Yard');
  await expect(group.getByRole('button', { name: 'Listen to Yard in the browser' })).toHaveCount(1);
  await render(page, { mute: true });
  await expect(group.getByRole('button', { name: 'Unmute Yard' })).toHaveCount(1);
});

test("the master's light follows the whole graph", async ({ page }) => {
  // Regression: 6c7bac818. The master has no node of its own; its light is
  // live when anything downstream is passing audio.
  await mixer(page);
  const led = () => page.locator('.pw-mixer-strip', { has: page.locator('#pwm_master') }).locator('i.fa-circle');
  await render(page, { entities: { 'sink:fpp_group_yard': 'running', 'slot:1': 'idle' } });
  await expect(led()).toHaveClass(/text-success/);
  await render(page, { entities: { 'sink:fpp_group_yard': 'idle' } });
  await expect(led()).toHaveClass(/text-secondary/);
  await render(page, { entities: {} });
  await expect(led()).toHaveClass(/text-body-tertiary/);
});

test('a section open by default collapses on the first click', async ({ page }) => {
  // Regression: 68a3cbc61. A section still on its default state stored
  // nothing, so the toggle flipped undefined to open and the first click did
  // nothing visible.
  await mixer(page);
  await render(page, {});
  const streams = page.getByRole('button', { name: /Media Stream Slots/ });
  await expect(streams).toHaveAttribute('aria-expanded', 'true');
  await streams.click();
  await expect(page.getByRole('button', { name: /Media Stream Slots/ })).toHaveAttribute('aria-expanded', 'false');
});
