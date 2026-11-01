import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The settings backups kept on the player are pruned as each new one is
// written.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const BACKUPS = '/home/fpp/media/config/backups';

// Feature: d24e12a84 (old locally stored settings backups are pruned once
// there are more than a minimum).  Today the 60 newest are kept; without the
// prune that runs after each backup is written they pile up for good.
test('backups written past the limit are pruned', async ({ request }) => {
  test.setTimeout(300_000);
  const list = () => inPlayer('sh', '-c', `ls ${BACKUPS} 2>/dev/null || true`).split('\n').filter((n) => n.endsWith('.json'));
  const before = new Set(list());
  try {
    for (let i = 0; i < 64; i++) {
      const made = await (await request.post('/api/backups/configuration', { data: `fpp-tests prune ${i}` })).json();
      expect(made.success, JSON.stringify(made)).toBe(true);
    }
    expect(list().length, 'backups were not pruned').toBeLessThanOrEqual(60);
  } finally {
    for (const n of list()) if (!before.has(n)) inPlayer('rm', '-f', `${BACKUPS}/${n}`);
  }
});
