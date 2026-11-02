import { test, expect } from './fixtures';

// An overlay model fppd creates itself (a Virtual Matrix's frame buffer, say)
// is listed on the Pixel Overlay Models page in its own table, where nothing
// can be edited: not its name and numbers, and not the Port of a frame buffer
// or the Parent of a sub-model, which are selects.  A model the user made has
// them enabled.  The models list is stood in for.

const model = (type: string, name: string, autoCreated: boolean, extra: object) => ({
  Name: name, Type: type, autoCreated, Width: 64, Height: 32, ChannelCount: 6144, StartChannel: 1, ...extra,
});

const MODELS = [
  model('FB', 'fpp-tests-fb', false, { Device: 'x11', PixelSize: 1, X: 0, Y: 0 }),
  model('Sub', 'fpp-tests-sub', false, { Parent: 'fpp-tests-fb', XOffset: 0, YOffset: 0 }),
  model('FB', 'fpp-tests-auto-fb', true, { Device: 'x11', PixelSize: 1, X: 0, Y: 0 }),
  model('Sub', 'fpp-tests-auto-sub', true, { Parent: 'fpp-tests-fb', XOffset: 0, YOffset: 0 }),
];

test('the Port and Parent selects of auto-created models are disabled, and a user model\'s are not', async ({ page }) => {
  // Regression: 8edf06aac.  Only the text and number fields of an
  // auto-created frame buffer or sub-model were disabled; its Port and
  // Parent selects could still be changed.
  await page.route('**/api/overlays/models', (route) => route.fulfill({ json: MODELS }));
  await page.goto('/pixeloverlaymodels.php');
  const mine = page.locator('#channelMemMaps tbody tr');
  const auto = page.locator('#channelMemMapsAutoCreate tbody tr');
  await expect(mine).toHaveCount(2, { timeout: 15_000 });
  await expect(auto).toHaveCount(2);

  // The control: the user's own models can be edited.
  await expect(mine.locator('select.device')).toBeEnabled();
  await expect(mine.locator('select.parent')).toBeEnabled();
  await expect(mine.locator('input.blk').first()).toBeEnabled();

  await expect(auto.locator('select.device')).toBeDisabled();
  await expect(auto.locator('select.parent')).toBeDisabled();
  await expect(auto.locator('input.blk').first()).toBeDisabled();
});
