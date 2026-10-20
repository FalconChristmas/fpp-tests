import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile } from './settings-file';

// Regression: 6aa2bc4e7 ("wire up the MultiSync log Reboot button and
// sequence DELETE"). DELETE /api/sequence/<name> was routed to DeleteSequence,
// a function that does not exist (the controller is DeleteSequences), so the
// documented endpoint failed and the sequence stayed. And the Reboot button in
// a MultiSync row's log called rebootRemoteFPP(), renamed long ago to
// rebootSystem(), so it threw a ReferenceError and did nothing.

test('DELETE /api/sequence/<name> deletes the sequence', async ({ request }) => {
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');
  const name = 'fpp-tests-delete.fseq';
  const file = `${MEDIA}/sequences/${name}`;
  putFile(file, 'fpp-tests not a real sequence');
  try {
    const r = await request.delete(`/api/sequence/${name}`);
    expect(r.status(), await r.text()).toBe(200);
    expect(exists(file), 'the sequence is still there').toBe(false);
  } finally {
    inPlayer('rm', '-f', file);
  }
});

test("the MultiSync log's Reboot button calls a function that exists", async ({ page }) => {
  await page.goto('/multisync.php');
  await page.waitForFunction(() => typeof (window as any).rebootSystem === 'function');
  const source = await (await page.request.get('/multisync.php')).text();
  // The control: the log's buttons are in the page.
  expect(source).toContain("value='Restart FPPD'");
  expect(source, 'the Reboot button calls a function that no longer exists').not.toContain('rebootRemoteFPP(');
  expect(source).toMatch(/value='Reboot' onClick='rebootSystem\(/);
});
