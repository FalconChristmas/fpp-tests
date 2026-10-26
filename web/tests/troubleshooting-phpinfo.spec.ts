import { test, expect } from './fixtures';
import { container } from './container';

// The Troubleshooting page's two PHP Info commands: php -i on the PHP tab
// (the command line PHP), and the web server's phpinfo() on the Webserver tab.

test.skip(!container, 'runs the troubleshooting commands inside the run-web.sh container');

test('the PHP tab shows the command line phpinfo and the Webserver tab the web one', async ({ page }) => {
  // Regression: 630044006.  Both commands had the key "PHPInfo": the second
  // replaced the first in the decoded JSON, so both tabs ran the web one, and
  // the two output elements shared one id.  Found here by tab, not by key.
  await page.goto('/troubleshooting.php');
  const out = (grp: string) => page.locator(`#pills-${grp} [id^="command_"]`);

  await page.locator('#pills-PHP-tab').click();
  await expect(out('PHP')).toHaveCount(1);
  await expect(out('PHP')).toContainText('Server API => Command Line Interface', { timeout: 30_000 });

  await page.locator('#pills-Webserver-tab').click();
  // The web one prints a page, which is shown in a frame.
  const frames = page.locator('#pills-Webserver iframe[id^="command_"]');
  await expect.poll(async () => (await frames.evaluateAll((fs) => fs.map((f) => f.getAttribute('srcdoc') ?? '')))
    .filter((d) => d.includes('FPM/FastCGI') && !d.includes('Command Line Interface')).length, { timeout: 30_000 }).toBe(1);

  const ids = await page.locator('[id^="command_"]').evaluateAll((es) => es.map((e) => e.id));
  expect(ids.filter((id, i) => ids.indexOf(id) !== i), 'output ids used twice').toEqual([]);
});
