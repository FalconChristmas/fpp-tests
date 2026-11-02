import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The Troubleshooting page shows the Webserver tab's Server Status, a page
// with no styles of its own, in a frame. It must take the page's theme, not
// a fixed white background.

test.skip(!container, 'runs the troubleshooting commands inside the run-web.sh container');

const CURL = '/usr/local/sbin/curl';

test.afterEach(() => {
  inPlayer('rm', '-f', CURL);
});

test('the Server Status frame follows the page theme instead of a fixed white background', async ({ page }) => {
  // Regression: d0baa5e9a.  The frame carried bg-white and the unstyled
  // server-status page had no color-scheme, so in the dark theme the status
  // was a white box in a dark page. The frame now has no background of its
  // own and the page inside opts into both schemes.
  putFile(CURL, '#!/bin/sh\n# fpp-tests stand-in\ncase "$*" in\n  *server-status*) echo "<html><body><h1>Apache Server Status for localhost</h1><table><tr><th>Srv</th><td>0-0</td></tr></table></body></html>"; exit 0;;\nesac\nexec /usr/bin/curl "$@"\n');
  inPlayer('chmod', '755', CURL);
  await page.goto('/troubleshooting.php');
  await page.locator('#pills-Webserver-tab').click();
  const frame = page.locator('#pills-Webserver iframe#command_Server-Status');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  await expect(frame).toHaveAttribute('srcdoc', /Apache Server Status for localhost/);

  const cls = (await frame.getAttribute('class')) ?? '';
  expect(cls).not.toContain('bg-white');
  expect(await frame.evaluate((f) => getComputedStyle(f).backgroundColor)).toBe('rgba(0, 0, 0, 0)');

  // the script ran in the frame's load handler: the styles it adds are there
  await expect.poll(() => frame.evaluate((f) => {
    const d = (f as HTMLIFrameElement).contentDocument;
    return d ? getComputedStyle(d.documentElement).colorScheme : '';
  })).toContain('dark');
});
