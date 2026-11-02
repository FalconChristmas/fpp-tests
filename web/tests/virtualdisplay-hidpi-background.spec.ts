import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingFile } from './privacy-helpers';

// The 2D Virtual Display draws the uploaded background
// (Images/virtualdisplaybackground.jpg) under the pixels, fitted to the
// canvas.  On a high-DPI screen (two device pixels to a CSS pixel here) it
// has to be drawn in the canvas's own coordinates, not scaled up again.

test.skip(!container, 'writes the background and the map in the run-web.sh container');
test.use({ deviceScaleFactor: 2 });

const MAP = '/home/fpp/media/config/virtualdisplaymap';
const BACKGROUND = '/home/fpp/media/images/virtualdisplaybackground.jpg';

test('on a high-DPI screen the background fills the canvas once, not doubled in size', async ({ page }) => {
  // Regression: 2e6b63a5b.  jCanvas drew the background at
  // devicePixelRatio times the canvas size, so on a hidpi display only its
  // top-left quarter showed; the page now draws it with the plain canvas API
  // at the canvas's size.
  // Also c9cf2ea2a: the background is fetched from api/file/Images/, not the
  // nonexistent api/Images/, so it is drawn at all.
  await page.goto('about:blank');
  // A 16:9 background, red on the left half and blue on the right.
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 90;
    const x = c.getContext('2d')!;
    x.fillStyle = '#ff0000'; x.fillRect(0, 0, 80, 90);
    x.fillStyle = '#0000ff'; x.fillRect(80, 0, 80, 90);
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  });
  await keepingFile(MAP, () => keepingFile(BACKGROUND, async () => {
    inPlayer('sh', '-c', `printf '160,90\\n2,2,0,3,RGB\\n' > ${MAP}`);
    inPlayer('sh', '-c', 'printf "%s" "$1" | base64 -d > "$2"', 'sh', jpeg, BACKGROUND);
    await page.goto('/virtualdisplaywrapper.php');
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    // [red, blue] at the middle of the left and right edges of the canvas.
    const edges = () => page.locator('#vCanvas').evaluate((c: HTMLCanvasElement) => {
      const x = c.getContext('2d')!;
      const at = (px: number) => Array.from(x.getImageData(px, Math.floor(c.height / 2), 1, 1).data.slice(0, 3));
      return [at(10), at(c.width - 10)];
    });
    await expect.poll(async () => {
      const [left, right] = await edges();
      return [left[0] > 200 && left[2] < 60 ? 'red' : String(left), right[2] > 200 && right[0] < 60 ? 'blue' : String(right)];
    }, { timeout: 10_000 }).toEqual(['red', 'blue']);
  }));
});
