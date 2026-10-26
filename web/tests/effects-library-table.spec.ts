import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Effects page's library table: the effects (and sequences) on the
// player, sortable and filterable by name, each with a Start button that
// asks fppd to run it.  fppd's running effects are the receiving end.

test.skip(!container, 'puts effects in the run-web.sh container\'s media');

const MEDIA = '/home/fpp/media';
const NAMES = ['fpp-tests-fx-b', 'fpp-tests-fx-a', 'fpp-tests-fx-c'];

test.beforeEach(() => {
  for (const n of NAMES) {
    inPlayer('python3', '-c', `import struct
frames = b"".join(bytes([i % 250 + 1] * 3) for i in range(40))
open("${MEDIA}/effects/${n}.eseq", "wb").write(b"ESEQ" + struct.pack("<B3xIII", 1, 3, 1, 3) + frames)`);
  }
});
test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Effects Stop', args: [] } });
  inPlayer('rm', '-f', ...NAMES.map((n) => `${MEDIA}/effects/${n}.eseq`));
});

test('the library lists the effects sorted by name, sorts both ways and filters by name, and Start runs one', async ({ page, request }) => {
  // Feature: 96fcec338 ("fully remove tablesorter - replaced by
  // bootstrap-table").  The table's sorting and filtering moved from
  // tablesorter to Bootstrap Table.
  await page.goto('/effects.php');
  const names = () => page.locator('#tblEffectLibrary tbody tr td:first-child').allInnerTexts()
    .then((t) => t.map((s) => s.trim()).filter((s) => s.startsWith('fpp-tests-fx')));
  await expect.poll(names).toEqual(['fpp-tests-fx-a', 'fpp-tests-fx-b', 'fpp-tests-fx-c']);

  await page.locator('#tblEffectLibrary thead th[data-field="name"] .sortable').click();
  await expect.poll(names).toEqual(['fpp-tests-fx-c', 'fpp-tests-fx-b', 'fpp-tests-fx-a']);

  await page.locator('#tblEffectLibrary thead th[data-field="name"] .filter-control input').fill('fx-b');
  await expect.poll(names, { timeout: 10_000 }).toEqual(['fpp-tests-fx-b']);

  await page.locator('#tblEffectLibrary tbody tr', { hasText: 'fpp-tests-fx-b' }).locator('button', { hasText: 'Start' }).click();
  await page.locator('#StartEffectDialog #loopEffect').check();
  await page.locator('#StartEffectDialog button', { hasText: 'Start' }).click();
  await expect.poll(async () => ((await (await request.get('/api/fppd/effects')).json()).runningEffects ?? [])
    .map((e: any) => e.name), { timeout: 10_000 }).toContain('fpp-tests-fx-b');
});
