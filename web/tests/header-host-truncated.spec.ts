import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The host name in the header bar is cut short (with an ellipsis) when it is
// longer than the bar has room for, rather than pushing the bar's other
// items off the screen.

test.skip(!container, 'sets the host name in the settings file inside the run-web.sh container');

test('a very long host name is truncated in the header at every width', async ({ page }) => {
  // Regression: 5b7b48a82.  The host name had no overflow rules or maximum
  // width, so a long one widened the header past a phone screen and the page
  // scrolled sideways.
  await keepingSettings(async () => {
    const name = 'a-very-long-host-name-' + 'x'.repeat(80);
    setSettingInFile('HostName', name);
    for (const width of [1600, 700, 500, 380]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/index.php?w=${width}`);
      const host = page.locator('#header_host');
      await expect(host).toContainText('a-very-long-host-name-');
      const m = await host.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          overflow: cs.overflow, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace,
          clipped: el.scrollWidth > el.clientWidth, width: el.getBoundingClientRect().width,
          pageScroll: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      const why = `at ${width}px: ${JSON.stringify(m)}`;
      expect(m.overflow, why).toBe('hidden');
      expect(m.textOverflow, why).toBe('ellipsis');
      expect(m.whiteSpace, why).toBe('nowrap');
      expect(m.clipped, `the name is cut short ${why}`).toBe(true);
      expect(m.width, `the name fits the screen ${why}`).toBeLessThan(width);
      expect(m.pageScroll, `the page scrolls sideways ${why}`).toBeLessThanOrEqual(0);
    }
  });
});
