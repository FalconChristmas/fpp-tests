import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, settingInFile } from './settings-file';

// The overlay model pickers and the Pixel Overlay Models page with xLights
// submodels and model groups. run-web.sh's player starts with an overlay
// model, fpp-tests-matrix, and an xLights export of a submodel of it,
// fpp-tests-matrix-cells, and a model group, fpp-tests-group (see
// scripts/web_serve.py). fppd builds a submodel or group the first time
// something names it.

test.skip(!container, 'needs the models run-web.sh seeds the player with');

const MODEL = 'fpp-tests-matrix';
const SUB = 'fpp-tests-matrix-cells';
const GROUP = 'fpp-tests-group';

// The overlay commands are offered from the Advanced UI level up.
let uiLevel: string | undefined;
test.beforeEach(async ({ request }) => {
  uiLevel = settingInFile('uiLevel');
  await request.put('/api/settings/uiLevel', { data: '3' });
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: uiLevel ?? '0' });
});

async function command(request, name: string, ...args: string[]) {
  const r = await request.post('/api/command', { data: { command: name, args } });
  expect(r.ok(), await r.text()).toBe(true);
}

async function startBars(request, model: string) {
  const desc = await (await request.get('/api/overlays/effects/Bars')).json();
  await command(request, 'Overlay Model Effect', model, 'Enabled', 'Bars',
    ...desc.args.map((a) => String(a.default ?? '')));
}

async function stopEffects(request, model: string) {
  await command(request, 'Overlay Model Effect', model, 'Enabled', 'Stop Effects');
  await request.put(`/api/overlays/model/${model}/state`, { data: { State: 0 } });
}

async function openEditor(page, cmd: string) {
  await page.goto('/commandPresets.php');
  await page.locator('button', { hasText: 'Add' }).first().click();
  await page.locator('#tblCommandsBody > tr').last().locator('input[value="Edit"]').click();
  await page.locator('#editorCommand').selectOption(cmd);
  return page.locator('#tblCommandEditor_arg_1');
}

const offered = (picker) => picker.locator('option').evaluateAll((os) => os.map((o: any) => o.value).sort());

// Feature: 5f0d2bc23 (the Type selector and filter over an overlay model
// picker in the command editor; before it, the picker listed the models
// alone). Until b4b022d17 its snapshot of the list raced the list's loading,
// and every view but the default came up empty.
test("the command editor's overlay model picker offers submodels and groups by type", async ({ page }) => {
  const picker = await openEditor(page, 'Overlay Model State');
  const bar = page.locator('#tblCommandEditor .ldOverlayFilter');
  await expect(bar, 'no Type selector over the model picker').toBeVisible();
  await expect.poll(() => offered(picker), { message: 'the Models view' }).toEqual([MODEL]);
  await bar.locator('.ldTypeFilter').selectOption('submodel');
  await expect.poll(() => offered(picker), { message: 'the Submodels view' }).toEqual([SUB]);
  await bar.locator('.ldTypeFilter').selectOption('group');
  await expect.poll(() => offered(picker), { message: 'the Model Groups view' }).toEqual([GROUP]);
  await bar.locator('.ldTypeFilter').selectOption('all');
  await expect.poll(() => offered(picker), { message: 'the All view' }).toEqual([GROUP, MODEL, SUB]);
  await bar.locator('.ldSearchFilter').fill('cells');
  await expect.poll(() => offered(picker), { message: 'filtered on "cells"' }).toEqual([SUB]);
});

// Feature: 6cff842b5. A submodel or group an effect runs on is built in
// fppd and listed with the overlay models, but it is not one to edit: the
// page keeps it out of the models table and shows the effect against it in
// its own table instead.
test('a submodel and a group running effects stay out of the models table and show their effects', async ({ page, request }) => {
  await startBars(request, SUB);
  await startBars(request, GROUP);
  try {
    await expect.poll(async () => (await (await request.get('/api/overlays/models')).json())
      .filter((m) => m.effectRunning).map((m) => m.Name).sort()).toEqual([GROUP, SUB]);
    await page.goto('/pixeloverlaymodels.php');
    const names = page.locator('#channelMemMaps tbody input.blk');
    await expect.poll(() => names.evaluateAll((es) => es.map((e: any) => e.value)),
      { message: 'the editable models table' }).toEqual([MODEL]);
    await page.locator(`#channelMemMaps tbody tr:has(input.blk[value="${MODEL}"]) .fa-sitemap`).click();
    const sub = page.locator('.submodelList tbody tr', { hasText: SUB });
    await expect(sub, "the submodel's effect").toContainText('Bars');
    await expect(page.locator('#modelGroupsTable tbody tr', { hasText: GROUP }), "the group's effect").toContainText('Bars');
  } finally {
    await stopEffects(request, SUB);
    await stopEffects(request, GROUP);
  }
});

// Feature: d93d73f82 (Running Effects: every effect running, on models,
// submodels and groups alike, with Stop All).
test('Running Effects lists the effects running and Stop All stops them', async ({ page, request }) => {
  await startBars(request, MODEL);
  await startBars(request, SUB);
  try {
    await page.goto('/pixeloverlaymodels.php');
    await page.locator('#btnRunningEffects').click();
    const body = page.locator('#runningFxBody');
    await expect(body).toContainText(MODEL);
    await expect(body).toContainText(SUB);
    await page.locator('.ui-dialog:visible button, .modal.show button', { hasText: 'Stop All' }).first().click();
    await expect.poll(async () => (await (await request.get('/api/overlays/running')).json()).length,
      { message: 'effects still running after Stop All' }).toBe(0);
    await expect(body).not.toContainText(SUB);
  } finally {
    await stopEffects(request, MODEL);
    await stopEffects(request, SUB);
  }
});

// Regression: 06ab87fcc. A command sent to other players by MultiSync
// reloads each argument's list from those players, from the URL the
// argument was drawn with; until that URL asked for submodels, a model
// picker reloaded this way lost them. The command editor rewrites its own
// pickers' URLs (5f0d2bc23), so this is seen in a playlist's command entry.
test.describe(() => {
  // On port 80 the page's own origin, which the UI's CSP admits; not here.
  test.use({ bypassCSP: true });
  test("a playlist command entry's model picker keeps submodels when MultiSync hosts are picked", async ({ page, request }) => {
    const name = 'fpp-tests-overlay-picker';
    await request.post(`/api/playlist/${name}`, { data: { name, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} } });
    try {
      await page.goto('/playlists.php');
      await page.locator('.playlistCard h3', { hasText: new RegExp(`^${name}$`) }).click();
      await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
      await page.locator('.playlistEntriesAddNewBtn').first().click();
      await page.selectOption('#pe_type', 'command');
      await page.selectOption('#playlistEntryOptions_arg_1', 'Overlay Model State');
      const picker = page.locator('#playlistEntryCommandOptions_arg_1');
      await expect.poll(() => offered(picker)).toContain(MODEL);
      await page.check('#playlistEntryCommandOptions_multisync');
      // This player, by the address the page was loaded from: the reload asks
      // it directly rather than through the proxy, on port 80, where a player
      // serves its UI; run-web.sh publishes it on another port.
      const base = new URL(page.url());
      await page.route(/^http:\/\/127\.0\.0\.1\/api\//, async (route) => {
        const u = new URL(route.request().url());
        u.port = base.port;
        await route.fulfill({ response: await route.fetch({ url: u.toString() }) });
      });
      const custom = page.locator('#playlistEntryCommandOptions_multisyncHostsCustom');
      if (await custom.count()) {
        await custom.fill('127.0.0.1');
        await custom.press('Enter');
      } else {
        // Before the host checkboxes, a text box.
        const hosts = page.locator('#playlistEntryCommandOptions_multisyncHosts');
        await hosts.fill('127.0.0.1');
        await hosts.dispatchEvent('change');
      }
      await expect.poll(() => offered(picker), { message: 'the picker after the reload' }).toEqual([GROUP, MODEL, SUB]);
    } finally {
      await request.delete(`/api/playlist/${name}`);
    }
  });
});

// Feature: 7336b9777. An xLights model's preview button opens its layout,
// from the 2D preview map xLights' FPP Connect uploads, drawn as points.
test("an xLights model's preview draws its layout", async ({ page }) => {
  const map = `${MEDIA}/config/virtualdisplaymap`;
  const had = exists(map);
  const before = had ? readFile(map) : '';
  putFile(map, ['400,400', `# Model: '${MODEL}'`, '10,10,0,0,3,RGB', '200,10,0,3,3,RGB', '10,200,0,6,3,RGB', ''].join('\n'));
  try {
    await page.goto('/pixeloverlaymodels.php');
    await page.locator(`#channelMemMaps tbody tr:has(input.blk[value="${MODEL}"]) .fa-eye`).click();
    const canvas = page.locator('.ui-dialog:visible canvas, .modal.show canvas').first();
    await expect(canvas).toBeVisible();
    // Points lit on the dark background.
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) lit++;
      return lit;
    }), { message: 'nothing drawn' }).toBeGreaterThan(0);
  } finally {
    if (had) putFile(map, before); else inPlayer('rm', '-f', map);
  }
});
