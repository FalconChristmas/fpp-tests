import { test, expect } from './fixtures';

// ProcessStreamedScript() (fpp.js) runs the <script class='streamScript'>
// blocks a streamed reply carries, fed one network packet at a time.  A
// packet boundary can fall anywhere: after a block's start tag, inside one,
// or with the end of one block and the start of the next in the same packet.

const START = "<script class='streamScript'>";
const END = '</script>';

// Feed the packets to the page's own function and report what the scripts did.
async function feed(page: import('@playwright/test').Page, packets: string[]): Promise<string[]> {
  await page.goto('/about.php');
  await page.waitForFunction(() => typeof (window as any).ProcessStreamedScript === 'function');
  return page.evaluate((chunks) => {
    const w = window as any;
    w.__ran = [];
    for (const c of chunks) w.ProcessStreamedScript(c);
    return w.__ran;
  }, packets);
}

test('scripts split across packets, or several to a packet, all run once and in order', async ({ page }) => {
  // Regression: 393ad873b (#1522).  The function looked for the start tag
  // only in the packet in hand, so a packet ending exactly at the start tag,
  // or cutting it in two, lost the block, and it took each packet's
  // remainder from one character past the end tag, so a health check that
  // answered in several scripts on some Pis never finished.
  const one = (n: number) => `${START}window.__ran.push(${n});${END}`;

  // The control: one whole block in one packet.
  expect(await feed(page, [one(1)])).toEqual([1]);

  // Two blocks in a packet, and a third that begins in the same one and
  // finishes in the next.
  expect(await feed(page, [one(1) + one(2) + `${START}window.__ran.push(`, `3);${END}`])).toEqual([1, 2, 3]);

  // A packet that ends right after the start tag.
  expect(await feed(page, [START, `window.__ran.push(4);${END}`])).toEqual([4]);

  // A start tag cut in two, and an end tag cut in two.
  expect(await feed(page, [START.slice(0, 10), START.slice(10) + 'window.__ran.push(5);</scr', 'ipt>' + one(6)])).toEqual([5, 6]);
});
