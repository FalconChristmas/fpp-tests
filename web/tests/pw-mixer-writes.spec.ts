import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// What the PipeWire mixer (www/js/pipewire-mixer.js) writes for each kind of
// control: the master, a stream slot, an output group and its card, an input
// bus and its sources, and a routing path, each to its own endpoint with the
// ids that name it; and the input and routing sections it draws.  As in
// pw-mixer.spec.ts the mixer's script is loaded into an ordinary page and fed
// a model of the graph (the container has no PipeWire); every write is
// recorded here and answered OK, or refused when a test says so.

type Write = { url: string; body: any };

// open: the sections to show; the input and routing sections are closed
// until opened (and remembered), so the tests open every one.
async function mixer(page: Page, refuse?: RegExp, open: object | null = { streams: true, groups: true, inputs: true, routing: true }) {
  const writes: Write[] = [];
  await page.route(/\/api\/(pipewire\/|system\/volume)/, (r) => {
    if (r.request().method() === 'GET') return r.fallback();
    const url = new URL(r.request().url()).pathname.replace(/^\//, '');
    writes.push({ url, body: JSON.parse(r.request().postData() || '{}') });
    return r.fulfill({ json: refuse && refuse.test(url) ? { status: 'ERROR', message: 'fpp-tests: no such sink' } : { status: 'OK' } });
  });
  await page.goto('/about.php');
  await page.evaluate((open) => open ? localStorage.setItem('pwMixerOpenSections', JSON.stringify(open))
    : localStorage.removeItem('pwMixerOpenSections'), open);
  await page.addScriptTag({ url: '/js/pipewire-mixer.js' });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', "<input id='slider' type='range' value='80'><div id='pwMixerBody'></div>");
    const w = window as any;
    w.pwMixer.data = {
      slots: [
        { slot: 1, status: 'playing', nodeName: 'fppd_stream_1', mediaFilename: 'song.mp3' },
        { slot: 2, status: 'idle', nodeName: 'fppd_stream_2' },
      ],
      slotVolumes: { 1: 90, 2: 40 },
      groups: [
        { id: 1, name: 'Yard', enabled: true, volume: 50, mute: false,
          members: [{ cardId: 'Card1', cardName: 'USB Card', volume: 60 }, { cardId: '' }] },
        { id: 2, name: 'Garage', enabled: false, members: [] },
      ],
      inputGroups: [
        { id: 3, name: 'Mics', enabled: true, volume: 70, mute: false, members: [
          // Slot 2 feeds only this bus, so its send is the slot's own level.
          { type: 'fppd_stream', sourceId: 'fppd_stream_2', name: 'Slot 2' },
          { type: 'capture', name: 'Stage Mic', volume: 55, mute: false },
        ] },
        { id: 4, name: 'Spare', enabled: false, members: [] },
      ],
      routing: [{ inputGroupId: 3, inputGroupName: 'Mics', paths: [
        { outputGroupId: 1, outputGroupName: 'Yard', connected: true, volume: 80, mute: false },
        { outputGroupId: 2, outputGroupName: 'Garage', connected: false },
      ] }],
      nodeStates: {}, entities: {},
    };
    w.PWMixerRender(true);
  });
  return writes;
}

const strip = (page: Page, id: string) => page.locator('.pw-mixer-strip', { has: page.locator(`#${id}`) });
test('the input and routing sections start closed, with their counts', async ({ page }) => {
  await mixer(page, undefined, null);
  const closed = page.locator('#pwMixerBody section button[aria-expanded=false]');
  await expect(closed).toHaveCount(2);
  await expect(closed.nth(0)).toContainText('Input Groups');
  await expect(closed.nth(0)).toContainText('1 bus · 1 send');
  await expect(closed.nth(1)).toContainText('Routing Matrix');
  await expect(closed.nth(1)).toContainText('1 connected');
  await expect(page.locator('#pwm_inputgroup_3')).toHaveCount(0);
  await closed.nth(0).click();
  await expect(page.locator('#pwm_inputgroup_3')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pwMixerOpenSections') || '{}'))).toMatchObject({ inputs: true });
});

test('the mixer draws the stream slots, input buses with their sends, routing paths and output groups', async ({ page }) => {
  await mixer(page);
  const body = page.locator('#pwMixerBody');
  await expect(body).toContainText('1 active');
  await expect(strip(page, 'pwm_slot_1')).toContainText('song.mp3');
  await expect(page.locator('#pwm_slot_1_val')).toHaveText('90%');
  await expect(strip(page, 'pwm_slot_2')).toContainText('Idle');

  // One enabled bus; of its two sources one is a send, the other slot 2
  // itself: read-only, at slot 2's level, no mute.
  await expect(body).toContainText('1 bus · 1 send');
  await expect(strip(page, 'pwm_inputgroup_3')).toContainText('Mix bus · 2 sources');
  const direct = strip(page, 'pwm_input_3_0');
  await expect(direct).toContainText('Direct · level is slot 2');
  await expect(page.locator('#pwm_input_3_0')).toBeDisabled();
  await expect(page.locator('#pwm_input_3_0')).toHaveValue('40');
  await expect(direct.locator('button[title^=Mute]')).toHaveCount(0);
  await expect(page.locator('#pwm_input_3_1')).toBeEnabled();
  await expect(page.locator('#pwm_inputgroup_4')).toHaveCount(0);

  // Only the connected path is drawn.
  await expect(body).toContainText('1 connected');
  await expect(strip(page, 'pwm_route_3_1')).toContainText('Mics → Yard');
  await expect(page.locator('#pwm_route_3_1_val')).toHaveText('80%');
  await expect(page.locator('#pwm_route_3_2')).toHaveCount(0);

  // The enabled group with its one card (a member with no card is not one),
  // and their levels once the master (80) is applied.
  await expect(body).toContainText('1 group · 1 output');
  await expect(strip(page, 'pwm_group_0')).toContainText('Group · 1 output');
  await expect(strip(page, 'pwm_group_0')).toContainText('→40%');
  await expect(strip(page, 'pwm_member_0_0')).toContainText('Output · USB Card');
  await expect(strip(page, 'pwm_member_0_0')).toContainText('→24%');
  await expect(page.locator('#pwm_group_1')).toHaveCount(0);
});

test('each fader writes its level to its own endpoint, naming what it sets', async ({ page }) => {
  const writes = await mixer(page);
  const expected: [string, string, object][] = [
    ['pwm_master', 'api/system/volume', { volume: 33 }],
    ['pwm_slot_1', 'api/pipewire/audio/stream/volume', { slot: 1, volume: 33 }],
    ['pwm_group_0', 'api/pipewire/audio/group/volume', { sink: 'fpp_group_yard', volume: 33 }],
    ['pwm_member_0_0', 'api/pipewire/audio/group/volume', { sink: 'fpp_fx_g1_card1', volume: 33 }],
    ['pwm_inputgroup_3', 'api/pipewire/audio/input-group/volume', { groupId: 3, volume: 33 }],
    ['pwm_input_3_1', 'api/pipewire/audio/input-groups/volume', { groupId: 3, memberIndex: 1, volume: 33 }],
    ['pwm_route_3_1', 'api/pipewire/audio/routing/volume', { inputGroupId: 3, outputGroupId: 1, volume: 33 }],
  ];
  for (const [id, url, body] of expected) {
    writes.length = 0;
    await page.locator(`#${id}`).fill('33');
    await expect(page.locator(`#${id}_val`)).toHaveText('33%');
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0], id).toEqual({ url, body });
  }
  // The master fader moves the page's own master too.
  await expect(page.locator('#slider')).toHaveValue('33');
});

test('a mute button writes the mute with the level shown, and turns into Unmute', async ({ page }) => {
  const writes = await mixer(page);
  await strip(page, 'pwm_group_0').locator('button[title="Mute Yard"]').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ url: 'api/pipewire/audio/group/volume', body: { sink: 'fpp_group_yard', volume: 50, mute: true } });
  const unmute = strip(page, 'pwm_group_0').locator('button[title="Unmute Yard"]');
  await expect(unmute).toBeVisible();
  await unmute.click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body.mute).toBe(false);

  await strip(page, 'pwm_member_0_0').locator('button[title="Mute Card1"]').click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2].body).toEqual({ sink: 'fpp_fx_g1_card1', volume: 60, mute: true });
  await expect(strip(page, 'pwm_member_0_0').locator('button[title="Unmute Card1"]')).toBeVisible();
});

// PWMixerSend() keeps the mute it sent in the model only for output groups
// and cards.  For a bus, a source or a route it writes the mute and redraws
// from the unchanged model: the button still says Mute, and a second click
// sends mute again instead of unmuting.  In FUTURE.md.
for (const [id, label, url] of [
  ['pwm_inputgroup_3', 'Mics', 'api/pipewire/audio/input-group/volume'],
  ['pwm_input_3_1', 'Stage Mic', 'api/pipewire/audio/input-groups/volume'],
  ['pwm_route_3_1', 'Mics → Yard', 'api/pipewire/audio/routing/volume'],
] as const) {
  test(`muting ${label} turns its button into Unmute, and the next click unmutes`, async ({ page }) => {
    const writes = await mixer(page);
    await strip(page, id).locator(`button[title="Mute ${label}"]`).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].url).toBe(url);
    expect(writes[0].body.mute).toBe(true);
    test.fail(true, 'the model keeps the old mute for buses, sources and routes (FUTURE.md)');
    await expect(strip(page, id).locator(`button[title="Unmute ${label}"]`)).toBeVisible({ timeout: 2000 });
    await strip(page, id).locator('button[title^=Unmute]').click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].body.mute).toBe(false);
  });
}

test('a write fppd refuses is said, not dropped', async ({ page }) => {
  const writes = await mixer(page, /routing\/volume/);
  await page.locator('#pwm_route_3_1').fill('10');
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.locator('.jGrowl-message', { hasText: 'fpp-tests: no such sink' })).toBeVisible();
});
