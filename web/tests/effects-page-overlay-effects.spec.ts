import { test, expect } from './fixtures';
import { container } from './container';

// The Effects page (effects.php) lists the overlay model effects running
// (the WLED and other Pixel Overlay effects), model by model, with a Stop
// for each.  fppd's /api/overlays/running is the other end, both of the
// list and of the Stop.  run-web.sh's player starts with an overlay model,
// fpp-tests-matrix (scripts/web_serve.py).

test.skip(!container, 'needs the overlay model run-web.sh seeds the player with');

const MODEL = 'fpp-tests-matrix';

async function command(request, name: string, ...args: string[]) {
  const r = await request.post('/api/command', { data: { command: name, args } });
  expect(r.ok(), await r.text()).toBe(true);
}
const running = async (request) => ((await (await request.get('/api/overlays/running')).json()) ?? [])
  .map((m: any) => [m.Name, m.effect?.name]);

test.afterEach(async ({ request }) => {
  await command(request, 'Overlay Model Effect', MODEL, 'Enabled', 'Stop Effects');
  await request.put(`/api/overlays/model/${MODEL}/state`, { data: { State: 0 } });
});

test('a running overlay model effect is listed on the Effects page, and its Stop stops it', async ({ page, request }) => {
  // Feature: db1d65720.  The page listed only the running .eseq effects; an
  // overlay effect (a WLED effect, Bars ...) running on a model was nowhere
  // in the UI except the model's own page.
  await page.goto('/effects.php');
  await expect(page.locator('#divOverlayEffects')).toHaveClass(/divOverlayEffectsDisabled/);
  await expect(page.locator('#tblOverlayEffectsBody tr')).toHaveCount(0);

  const desc = await (await request.get('/api/overlays/effects/Bars')).json();
  await command(request, 'Overlay Model Effect', MODEL, 'Enabled', 'Bars',
    ...desc.args.map((a) => String(a.default ?? '')));
  await expect.poll(() => running(request)).toEqual([[MODEL, 'Bars']]);

  const row = page.locator('#tblOverlayEffectsBody tr');
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  await expect(row.locator('td').nth(0)).toHaveText(MODEL);
  await expect(row.locator('td').nth(1)).toHaveText('Bars');
  await expect(page.locator('#divOverlayEffects')).toHaveClass(/divOverlayEffectsRunning/);

  await row.locator('button.stop-overlay-effects').click();
  await expect.poll(() => running(request), { timeout: 10_000, message: 'fppd\'s running overlay effects after Stop' })
    .toEqual([]);
  await expect(page.locator('#tblOverlayEffectsBody tr')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('#divOverlayEffects')).toHaveClass(/divOverlayEffectsDisabled/);
});
