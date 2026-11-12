import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Save on the Pixel Overlay Models page.  The page draws fppd's running
// models (api/overlays/models) and Save posts the whole table back
// (api/models) as the new model file, so a field a row does not carry, or
// reads back wrongly, is lost from every model at the next Save, whichever
// one was being edited.  What the page is given and what it posts are both
// the test's: the models and the post are answered here, and nothing is
// written to the player.  (overlay-models-restart-flag.spec.ts covers what
// the player does with the post.)

type Model = Record<string, unknown>;

const channel = (Name: string, extra: Model = {}): Model => ({
  Name, Type: 'Channel', StartChannel: 1, ChannelCount: 150, ChannelCountPerNode: 3, Orientation: 'horizontal',
  StartCorner: 'TL', StringCount: 5, StrandsPerString: 1, xLights: false, effectRunning: false, ...extra,
});
const fb = (Name: string, extra: Model = {}): Model => ({
  Name, Type: 'FB', Device: 'fb9', Width: 640, Height: 480, PixelSize: 4, effectRunning: false, ...extra,
});
const sub = (Name: string, extra: Model = {}): Model => ({
  Name, Type: 'Sub', Parent: 'fpp-tests-matrix', Width: 8, Height: 4, XOffset: 2, YOffset: 1, effectRunning: false, ...extra,
});

async function open(page: Page, models: Model[], o: { autoCreate?: boolean; saveStatus?: number; loadStatus?: number } = {}) {
  const posts: { models: Model[]; autoCreate: boolean }[] = [];
  const flags: string[] = [];
  const alerts: string[] = [];
  page.on('dialog', (d) => {
    alerts.push(d.message());
    return d.accept();
  });
  await page.route((u) => u.pathname.endsWith('/api/overlays/models'), (route) =>
    o.loadStatus ? route.fulfill({ status: o.loadStatus, body: 'no' }) : route.fulfill({ json: models }));
  await page.route((u) => u.pathname.endsWith('/api/overlays/settings'), (route) => route.fulfill({ json: { autoCreate: o.autoCreate ?? true } }));
  await page.route((u) => u.pathname.endsWith('/api/models'), (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts.push(JSON.parse(route.request().postData() ?? '{}'));
    return o.saveStatus ? route.fulfill({ status: o.saveStatus, body: 'no' }) : route.fulfill({ json: { Status: 'OK' } });
  });
  // The restart flag a save raises is a setting: kept off the player.
  await page.route((u) => u.pathname.includes('/api/settings/'), (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    flags.push(new URL(route.request().url()).pathname.replace(/\/$/, '').split('/').pop()!);
    return route.fulfill({ json: { status: 'OK' } });
  });
  await page.goto('/pixeloverlaymodels.php');
  if (!o.loadStatus) await expect(page.locator('#channelMemMaps tbody tr, #channelMemMapsAutoCreate tbody tr')).toHaveCount(models.length, { timeout: 15_000 });
  return { posts, flags, alerts };
}

const rows = (page: Page) => page.locator('#channelMemMaps tbody tr');
const row = (page: Page, name: string) => rows(page).filter({ has: page.locator(`input.blk[value="${name}"]`) });
const save = (page: Page) => page.locator('input[type=button][value="Save"]:visible').first().click();
async function saved(page: Page, posts: { models: Model[] }[]) {
  const before = posts.length;
  await save(page);
  await expect.poll(() => posts.length).toBe(before + 1);
  return posts[posts.length - 1].models;
}
// What a posted model may hold beyond what it was given: nothing.
const given = (m: Model) => {
  const { effectRunning, ...rest } = m;
  return rest;
};
const settle = (page: Page) => page.waitForTimeout(600);

test.describe('a channel model', () => {
  test('is posted back with every field it was shown with', async ({ page }) => {
    const models = [
      channel('arch-left'),
      channel('tree', { StartChannel: 451, ChannelCount: 800, ChannelCountPerNode: 4, Orientation: 'vertical', StartCorner: 'BR', StringCount: 16, StrandsPerString: 2 }),
    ];
    const { posts } = await open(page, models);
    const tree = row(page, 'tree');
    await expect(tree.locator('input.start')).toHaveValue('451');
    await expect(tree.locator('input.cnt')).toHaveValue('800');
    await expect(tree.locator('.cpn')).toHaveValue('4');
    await expect(tree.locator('select.orientation')).toHaveValue('vertical');
    await expect(tree.locator('select.corner')).toHaveValue('BR');
    await expect(tree.locator('input.strcnt')).toHaveValue('16');
    await expect(tree.locator('input.strands')).toHaveValue('2');
    expect(await saved(page, posts)).toEqual(models.map(given));
  });

  test('made by xLights stays marked so, though its box cannot be changed here', async ({ page }) => {
    const models = [channel('from-xlights', { xLights: true }), channel('by-hand')];
    const { posts } = await open(page, models);
    await expect(row(page, 'from-xlights').locator('input.xlights')).toBeChecked();
    await expect(row(page, 'from-xlights').locator('input.xlights')).toBeDisabled();
    await expect(row(page, 'by-hand').locator('input.xlights')).not.toBeChecked();
    expect((await saved(page, posts)).map((m) => m.xLights)).toEqual([true, false]);
  });

  test('that is edited is posted with the new numbers, as numbers', async ({ page }) => {
    const { posts } = await open(page, [channel('arch-left')]);
    const r = row(page, 'arch-left');
    await r.locator('input.start').fill('301');
    await r.locator('input.cnt').fill('90');
    await r.locator('input.strcnt').fill('3');
    await r.locator('select.corner').selectOption('BL');
    await r.locator('input.blk').fill('arch-right');
    expect(await saved(page, posts)).toEqual([given(channel('arch-right', { StartChannel: 301, ChannelCount: 90, StringCount: 3, StartCorner: 'BL' }))]);
  });

  test('with a custom layout keeps its compressed layout and corner, which the row has no fields for', async ({ page }) => {
    const custom = channel('snowflake', { Orientation: 'custom', StartCorner: 'TL', compressedData: 'eJwzNDAw0DEEYSMgNgYAGPgC1Q==', StringCount: 1, StrandsPerString: 1 });
    const { posts } = await open(page, [custom, channel('arch-left')]);
    const r = row(page, 'snowflake');
    await expect(r).toContainText('custom');
    await expect(r.locator('select.corner')).toHaveCount(0);
    expect(await saved(page, posts)).toEqual([given(custom), given(channel('arch-left'))]);
  });

  test('with a custom layout held as plain data keeps it, and shows the size of its grid', async ({ page }) => {
    const custom = channel('star', { Orientation: 'custom', data: '1,2,3;4,5,6', ChannelCount: 18, StringCount: 1, StrandsPerString: 1 });
    const { posts } = await open(page, [custom]);
    await expect(row(page, 'star')).toContainText(/custom\s+3\s+x\s+2/);
    const [posted] = await saved(page, posts);
    expect(posted).toEqual(given(custom));
    expect(posted).not.toHaveProperty('compressedData');
  });

  test('with an effect running on it says which', async ({ page }) => {
    await open(page, [channel('arch-left', { effectRunning: true, effectName: 'Color Wash' }), channel('idle')]);
    await expect(row(page, 'arch-left').locator('td').last()).toContainText('Color Wash');
    await expect(row(page, 'idle').locator('td').last()).toHaveText('—');
  });
});

test.describe('a model that cannot work', () => {
  for (const [what, edit] of [
    ['no strings', { field: 'input.strcnt', value: '0' }],
    ['no strands', { field: 'input.strands', value: '0' }],
    ['no name', { field: 'input.blk', value: '' }],
  ] as const) {
    test(`(${what}) stops the save: nothing is posted, for any model`, async ({ page }) => {
      const { posts, alerts, flags } = await open(page, [channel('good'), channel('bad', { StartChannel: 200 })]);
      await row(page, 'bad').locator(edit.field).fill(edit.value);
      await save(page);
      await expect.poll(() => alerts.length).toBe(1);
      expect(alerts[0]).toContain('is not valid.');
      await settle(page);
      expect(posts).toEqual([]);
      expect(flags).not.toContain('restartFlag');
    });
  }

  for (const [what, edit] of [
    ['a start channel of 0', { field: 'input.start', value: '0' }],
    ['no channels', { field: 'input.cnt', value: '0' }],
  ] as const) {
    test(`(${what}) stops the save too, rather than being dropped from it`, async ({ page }) => {
      const { posts, alerts } = await open(page, [channel('good'), channel('bad', { StartChannel: 200 })]);
      await row(page, 'bad').locator(edit.field).fill(edit.value);
      await save(page);
      await settle(page);
      test.fail(true, 'the model is left out of the post without a word, and the save reported as done (FUTURE.md)');
      expect(alerts).toHaveLength(1);
      expect(posts).toEqual([]);
    });
  }

  test('is named in the message that stops the save', async ({ page }) => {
    const { alerts } = await open(page, [channel('good'), channel('porch-roof', { StartChannel: 200 })]);
    await row(page, 'porch-roof').locator('input.strcnt').fill('0');
    await save(page);
    await expect.poll(() => alerts.length).toBe(1);
    // The control: its channels are named.
    expect(alerts[0]).toContain("starting at channel '200' containing '150' channel(s)");
    test.fail(true, "the message reads model.BlockName, which no model has: \"MemMap 'undefined'\" (FUTURE.md)");
    expect(alerts[0]).toContain('porch-roof');
  });
});

test.describe('a framebuffer model', () => {
  test('on a device this player does not have now keeps its device, size and pixel size', async ({ page }) => {
    // An HDMI output that is unplugged, or a model restored from another player.
    const { posts } = await open(page, [fb('wall'), channel('arch-left')]);
    const r = row(page, 'wall');
    await expect(r.locator('select.device')).toHaveValue('fb9');
    await expect(r.locator('input.width')).toHaveValue('640');
    await expect(r.locator('input.height')).toHaveValue('480');
    await expect(r.locator('input.pixelSize')).toHaveValue('4');
    // 160 x 120 pixels of three channels.
    await expect(r.locator('td.channels')).toHaveText('57600');
    const [posted] = await saved(page, posts);
    expect(posted).toMatchObject({ Name: 'wall', Type: 'FB', Device: 'fb9', Width: 640, Height: 480, PixelSize: 4 });
  });

  test('resized or given bigger pixels shows the channels it will then take, and posts the new size', async ({ page }) => {
    const { posts } = await open(page, [fb('wall')]);
    const r = row(page, 'wall');
    await r.locator('input.width').fill('320');
    await r.locator('input.width').dispatchEvent('change');
    await expect(r.locator('td.channels')).toHaveText(String(80 * 120 * 3));
    await r.locator('input.pixelSize').fill('8');
    await r.locator('input.pixelSize').dispatchEvent('change');
    await expect(r.locator('td.channels')).toHaveText(String(40 * 60 * 3));
    expect((await saved(page, posts))[0]).toMatchObject({ Width: 320, Height: 480, PixelSize: 8 });
  });

  test('in an X11 window keeps where the window is', async ({ page }) => {
    const { posts } = await open(page, [fb('window', { Device: 'x11', X: 64, Y: 128, PixelSize: 1 })]);
    const r = row(page, 'window');
    await expect(r.locator('input.xOffset')).toHaveValue('64');
    await expect(r.locator('input.yOffset')).toHaveValue('128');
    expect((await saved(page, posts))[0]).toMatchObject({ Device: 'x11', X: 64, Y: 128, Width: 640, Height: 480 });
  });
});

test.describe('a sub-model', () => {
  test('keeps its parent, offsets and size', async ({ page }) => {
    const { posts } = await open(page, [channel('fpp-tests-matrix'), sub('matrix-corner')]);
    const r = row(page, 'matrix-corner');
    await expect(r.locator('select.parent')).toHaveValue('fpp-tests-matrix');
    await expect(r.locator('input.xOffset')).toHaveValue('2');
    await expect(r.locator('input.yOffset')).toHaveValue('1');
    await expect(r.locator('td.channels')).toHaveText(String(8 * 4 * 3));
    expect((await saved(page, posts))[1]).toEqual(given(sub('matrix-corner')));
  });

  test('of a parent that is not a model here keeps the parent it names', async ({ page }) => {
    const { posts } = await open(page, [sub('orphan', { Parent: 'gone-model' })]);
    await expect(row(page, 'orphan').locator('select.parent')).toHaveValue('gone-model');
    expect((await saved(page, posts))[0]).toMatchObject({ Parent: 'gone-model' });
  });

  test('resized shows the channels it will take and posts the new size', async ({ page }) => {
    const { posts } = await open(page, [sub('matrix-corner')]);
    const r = row(page, 'matrix-corner');
    await r.locator('input.height').fill('2');
    await r.locator('input.height').dispatchEvent('change');
    await expect(r.locator('td.channels')).toHaveText(String(8 * 2 * 3));
    await r.locator('input.xOffset').fill('0');
    expect((await saved(page, posts))[0]).toMatchObject({ Width: 8, Height: 2, XOffset: 0, YOffset: 1 });
  });
});

test('models made automatically from the outputs are listed apart, cannot be edited, and are not posted', async ({ page }) => {
  const { posts } = await open(page, [channel('by-hand'), channel('LED Panel Matrix #1', { autoCreated: true, StartChannel: 1000 })]);
  await expect(rows(page)).toHaveCount(1);
  const auto = page.locator('#channelMemMapsAutoCreate tbody tr');
  await expect(auto).toHaveCount(1);
  await expect(auto.locator('input.blk')).toHaveValue('LED Panel Matrix #1');
  await expect(auto.locator('input.blk')).toBeDisabled();
  await expect(auto.locator('input.start')).toBeDisabled();
  expect((await saved(page, posts)).map((m) => m.Name)).toEqual(['by-hand']);
});

for (const autoCreate of [true, false]) {
  test(`the "create automatically" box is shown ${autoCreate ? 'ticked' : 'clear'} as saved, and its opposite is what is posted once changed`, async ({ page }) => {
    const { posts } = await open(page, [channel('arch-left')], { autoCreate });
    const box = page.locator('#AutoCreatePixelOverlays');
    autoCreate ? await expect(box).toBeChecked() : await expect(box).not.toBeChecked();
    await saved(page, posts);
    expect(posts[0].autoCreate).toBe(autoCreate);
    await box.click();
    await saved(page, posts);
    expect(posts[1].autoCreate).toBe(!autoCreate);
  });
}

test('a save that is taken says so and asks for an fppd restart', async ({ page }) => {
  const { posts, flags } = await open(page, [channel('arch-left')]);
  await saved(page, posts);
  await expect(page.locator('.jGrowl-notification', { hasText: 'Pixel Overlay Models saved.' })).toBeVisible();
  await expect.poll(() => flags).toContain('restartFlag');
});

test('a save the player does not take is reported, with no restart asked for and the rows as typed', async ({ page }) => {
  const { posts, flags } = await open(page, [channel('arch-left')], { saveStatus: 500 });
  await row(page, 'arch-left').locator('input.cnt').fill('99');
  await save(page);
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Save Failed, is fppd running?');
  await expect(dialog.locator('.modal-title')).toHaveText('Save Pixel Overlay Models');
  expect(posts).toHaveLength(1);
  expect(await page.locator('.jGrowl-notification', { hasText: 'Pixel Overlay Models saved.' }).count()).toBe(0);
  expect(flags).not.toContain('restartFlag');
  await expect(rows(page).first().locator('input.cnt')).toHaveValue('99');
});

test('models that cannot be read are reported, and the empty table is not there to be saved over them', async ({ page }) => {
  const { posts } = await open(page, [], { loadStatus: 500 });
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Load Failed, is fppd running?');
  await expect(dialog.locator('.modal-title')).toHaveText('Load Pixel Overlay Models');
  await dialog.locator('button', { hasText: 'Close' }).click();
  await expect(rows(page)).toHaveCount(0);
  await save(page);
  await settle(page);
  test.fail(true, 'Save stays live after a failed load and posts an empty model list over the saved models (FUTURE.md)');
  expect(posts).toEqual([]);
});

test.describe('a new model', () => {
  async function add(page: Page, kind: 'Channel' | 'SubModel') {
    await page.locator('button[value=Add]').click();
    const dialog = page.locator('#AddPixelOverlayModel');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: kind, exact: true }).click();
    return rows(page).last();
  }

  test('of channels starts as 150 channels of RGB in one string from channel 1, and is posted once named', async ({ page }) => {
    const { posts } = await open(page, [channel('arch-left')]);
    const r = await add(page, 'Channel');
    await expect(rows(page)).toHaveCount(2);
    await expect(r.locator('input.start')).toHaveValue('1');
    await expect(r.locator('input.cnt')).toHaveValue('150');
    await expect(r.locator('.cpn')).toHaveValue('3');
    await expect(r.locator('input.strcnt')).toHaveValue('1');
    await r.locator('input.blk').fill('new-arch');
    expect((await saved(page, posts))[1]).toEqual({
      Name: 'new-arch', Type: 'Channel', StartChannel: 1, ChannelCount: 150, ChannelCountPerNode: 3, Orientation: 'horizontal',
      StartCorner: 'TL', StringCount: 1, StrandsPerString: 1, xLights: false,
    });
  });

  test('that is a sub-model offers this player\'s models as its parent and starts at 64 by 32', async ({ page }) => {
    const { posts } = await open(page, [channel('fpp-tests-matrix')]);
    const r = await add(page, 'SubModel');
    await expect(r.locator('select.parent option[value="fpp-tests-matrix"]')).toHaveCount(1);
    await expect(r.locator('input.width')).toHaveValue('64');
    await expect(r.locator('input.height')).toHaveValue('32');
    await expect(r.locator('td.channels')).toHaveText(String(64 * 32 * 3));
    await r.locator('input.blk').fill('new-sub');
    await r.locator('select.parent').selectOption('fpp-tests-matrix');
    expect((await saved(page, posts))[1]).toEqual({ Name: 'new-sub', Type: 'Sub', Width: 64, Height: 32, XOffset: 0, YOffset: 0, Parent: 'fpp-tests-matrix' });
  });
});

test('a deleted model is not posted, and the others are, in the order shown', async ({ page }) => {
  const { posts } = await open(page, [channel('one'), channel('two'), channel('three')]);
  await row(page, 'two').locator('td').first().dispatchEvent('mousedown');
  await page.locator('#btnDelete').click();
  await expect(rows(page)).toHaveCount(2);
  expect((await saved(page, posts)).map((m) => m.Name)).toEqual(['one', 'three']);
});
