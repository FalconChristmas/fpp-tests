import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingFile } from './privacy-helpers';

// The 2D Virtual Display page the menu opens (virtualdisplaywrapper.php):
// its canvas is 1024 wide by default, 16:9, fitted to the shape of the
// preview in virtualdisplaymap; ?width= asks for another width, for a screen
// the default doesn't suit.

test.skip(!container, 'writes the virtual display map in the run-web.sh container');

const MAP = '/home/fpp/media/config/virtualdisplaymap';

test('?width= sets the width of the Virtual Display canvas', async ({ page }) => {
  // Regression: 3e55e3844.  The menu's page was always the default size;
  // like virtualdisplay.php it now takes ?width=, with the height to match
  // at 16:9.
  await keepingFile(MAP, async () => {
    // A 16:9 preview, so the canvas takes the size asked for as it is.
    inPlayer('sh', '-c', `printf '160,90\\n2,2,0,3,RGB\\n' > ${MAP}`);
    const size = () => page.locator('#vCanvas').evaluate((c: HTMLCanvasElement) => `${c.width}x${c.height}`);
    await page.goto('/virtualdisplaywrapper.php');
    expect(await size()).toBe('1024x576');
    await page.goto('/virtualdisplaywrapper.php?width=640');
    expect(await size()).toBe('640x360');
  });
});
