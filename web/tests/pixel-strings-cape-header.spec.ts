import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The header of the Pixel Strings tab and the LED Panels tab beside it, on a
// BeagleBone with a strings-only cape.  The cape is set up as in
// pixel-strings-page.spec.ts: the player claims to be a BeagleBone for the
// length of each test, and the cape is media/tmp/cape-info.json.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_FILE = `${STRINGS_DIR}/FppTestsStrings.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsStrings', longName: 'fpp-tests 2-port string cape', numSerial: 0,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }],
  groups: [{ start: 1, count: 2 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsStrings', name: 'fpp-tests strings', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

function vstring(description: string, startChannel: number, pixelCount: number) {
  return {
    description, startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
    nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
  };
}

// Two ports of pixels, so the page has something to work a frame rate out of.
const STRINGS_CONFIG = {
  channelOutputs: [{
    type: 'BBB48String', subType: 'FppTestsStrings', pinoutVersion: '1.x', enabled: 1,
    startChannel: 1, channelCount: -1, outputCount: 2,
    outputs: [
      { portNumber: 0, protocol: 'ws2811', differentialType: 0, virtualStrings: [vstring('first', 0, 50)] },
      { portNumber: 1, protocol: 'ws2811', differentialType: 0, virtualStrings: [vstring('second', 150, 50)] },
    ],
  }],
};

function writeFile(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}

function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let saved: Record<string, string | null> = {};

test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, CONFIG]) {
    saved[p] = readFile(p);
  }
  writeFile(PLATFORM, 'BeagleBone Black');
  writeFile(CAPE_FILE, JSON.stringify(CAPE));
  writeFile(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
  writeFile(CONFIG, JSON.stringify(STRINGS_CONFIG));
});

test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) {
      inPlayer('rm', '-f', p);
    } else {
      writeFile(p, content);
    }
  }
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#divPixelString .tableTabPageHeader h2')).toHaveText('fpp-tests strings', { timeout: 15_000 });
}

test("a strings-only cape's name heads the Pixel Strings tab and leaves the LED Panels tab's alone", async ({ page }) => {
  // Regression: 3d801f543.  Both tabs set their header from the cape's name
  // through the same "capeName" class, so the cape's name, which the LED Panels
  // tab was never told it provides, replaced "LED Panel Matrices" (and
  // "Enable LED Panels") there as well.
  await openStrings(page);
  await expect(page.locator('#divPixelString .tableTabPageHeader h2')).toHaveText('fpp-tests strings');
  await expect(page.locator('#divPixelString .enableCheckboxWrapper b')).toContainText('Enable fpp-tests strings');

  // The LED Panels tab keeps its own words.
  await expect(page.locator('#divLEDPanelMatrices .tableTabPageHeader h2')).toHaveText(/LED Panel/i);
  expect(await page.locator('#divLEDPanelMatrices').textContent(), "the LED Panels tab was given the string cape's name")
    .not.toContain('fpp-tests strings');
});

test('the Testing control stays on the header\'s first line, at the right edge, as the window narrows', async ({ page }) => {
  // Regression: 9cad6d17d.  The max-FPS note sat between Pixel Timing and
  // Testing at a fixed width, so a narrower window pushed Testing onto a
  // second line while the note stayed on the first.  The note is the row's
  // only elastic item now, which pins Testing to the right edge and, below
  // 1400px, drops to a line of its own after Testing.
  await openStrings(page);
  const note = page.locator('#pixelStringMaxFPS');
  await expect(note).toContainText('fps max');
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;

  for (const width of [1300, 1399, 1400, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await box('#PixelTestPatternDiv')).x, { message: `layout at ${width}px` }).toBeGreaterThan(0);
    const timing = await box('#BBPixelTiming');
    const testing = await box('#PixelTestPatternDiv');
    const area = await box('#divPixelString');
    const nb = await note.boundingBox();

    expect(Math.abs(testing.y - timing.y), `Testing pushed off the first line at ${width}px`).toBeLessThan(12);
    expect(testing.x, `Testing before Pixel Timing at ${width}px`).toBeGreaterThan(timing.x + timing.width);
    // Pinned right: no other control is to its right and nothing but the
    // page's padding is between it and the edge of the tab.
    expect(area.x + area.width - (testing.x + testing.width), `Testing's distance from the right edge at ${width}px`).toBeLessThan(40);
    if (width < 1400) {
      expect(nb!.y, `the note beside Testing at ${width}px instead of below`).toBeGreaterThan(testing.y + testing.height - 12);
    }
  }
});
