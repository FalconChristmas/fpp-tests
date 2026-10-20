import { test, expect } from './fixtures';

// StreamURL(), behind every streamed-output popup, appended what it streamed
// with innerHTML and eval()'d any <script class='streamScript'> block in it,
// so whatever a streamed command printed -- a file name, a remote's answer --
// ran as markup and script.  Fixed in fpp 8f713e7d1 ("fix(js): Render streamed
// output as inert text; gate streamed-script eval (#3051)"): it is text unless
// the caller asks for raw HTML, and script blocks need their own opt-in.

const FILE = 'fpp-tests-stream.txt';
const CONTENT = "<img src=x onerror=window.__fppTestsStreamImg=1><script class='streamScript'>window.__fppTestsStreamScript=1</script>\n";

test('streamed output is shown as text and its scripts do not run', async ({ page, request }) => {
  expect((await request.post(`/api/file/Uploads/${FILE}`, { data: CONTENT })).ok()).toBe(true);
  try {
    await page.goto('/index.php');
    await page.waitForFunction(() => typeof (window as any).StreamURL === 'function');
    await page.evaluate((file) => {
      const div = document.createElement('div');
      div.id = 'fppTestsStream';
      document.body.appendChild(div);
      (window as any).StreamURL(`api/file/Uploads/${file}`, 'fppTestsStream');
    }, FILE);
    const out = page.locator('#fppTestsStream');
    // As text: markup would leave no "<img" in the text, only an element.
    await expect(out).toContainText('<img src=x');
    await expect(out.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => [(window as any).__fppTestsStreamImg, (window as any).__fppTestsStreamScript]))
      .toEqual([undefined, undefined]);
  } finally {
    await request.delete(`/api/file/Uploads/${FILE}`);
  }
});
