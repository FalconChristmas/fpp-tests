import { test, expect } from './fixtures';

// settings-all.php draws the Settings page's tabs from an array of pages,
// each with a "ui" level; the tabs a Basic UI shows are always there.

test('the Settings page draws the tabs a Basic UI shows', async ({ request }) => {
  // Regression: 0ddda23a7.  The array's "ui" keys were bare words, which PHP
  // 8 refuses as undefined constants: the page died after its head had been
  // sent, so it still answered 200 -- with no tabs at all.
  const r = await request.get('/settings-all.php');
  expect(r.status()).toBe(200);
  const body = await r.text();
  for (const name of ['playback', 'av', 'time', 'ui', 'email', 'mqtt', 'system']) {
    expect(body, `the ${name} tab`).toContain(`id="settings-${name}-tab"`);
  }
  expect(body, 'the playback pane').toContain('id="settings-playback" role="tabpanel"');
});
