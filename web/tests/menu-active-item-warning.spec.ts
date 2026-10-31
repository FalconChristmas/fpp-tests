import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The header menu (menu.inc) marks the active top-level menu from
// $activeParentMenuItem, which each page sets before including it.  PHP's
// warnings go to the media directory's apache2-error.log.

test.skip(!container, 'reads the PHP error log inside the run-web.sh container');

const LOG = '/home/fpp/media/logs/apache2-error.log';

test('a page that names no active menu draws the menu without a PHP warning', async ({ request }) => {
  // Regression: 937745e7c.  menu.inc read $activeParentMenuItem whether or
  // not the page had set it, so the initial setup page (and the others that
  // don't) logged "Undefined variable $activeParentMenuItem" on every load.
  const count = () => Number(inPlayer('sh', '-c', `grep -c 'activeParentMenuItem' ${LOG} 2>/dev/null || true`).trim() || 0);
  const before = count();
  for (const path of ['/initialSetup.php', '/cronjobs.php', '/settings-all.php']) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    // The control: the menu was drawn.
    expect(await r.text(), path).toContain('class="header"');
  }
  await new Promise((r) => setTimeout(r, 500));
  expect(count() - before, inPlayer('sh', '-c', `grep activeParentMenuItem ${LOG} | tail -3 || true`)).toBe(0);
});
