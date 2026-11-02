import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Pixel Strings tab warns, on the start channel of each string involved,
// when the channel ranges of two strings overlap (see
// pixel-strings-cape-warnings.spec.ts, whose harness this repeats): the player
// claims to be a Pi for the length of each test, the cape is put where cape
// detection unpacks it from the EEPROM, and the string config is written
// where the page loads it from.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const CAPE_FILE = `${MEDIA}/tmp/strings/FppTestsStrings.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const PI_CONFIG = `${MEDIA}/config/co-pixelStrings.json`;

const CAPE = {
  name: 'FppTestsStrings', longName: 'fpp-tests string cape', numSerial: 0, driver: 'spixels',
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }, { pin: 'P8-12' }],
  groups: [{ start: 1, count: 3 }],
};

const vstring = (startChannel: number, pixelCount: number) => ({
  description: 'fpp-tests', startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
  nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
});

// One string per output, each starting at the channel (0-based) given.
function stringsConfig(starts: number[], pixels = 50) {
  return {
    channelOutputs: [{
      type: 'spixels', subType: 'FppTestsStrings', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: starts.length,
      outputs: starts.map((s, i) => ({ portNumber: i, protocol: 'ws2811', differentialType: 0, virtualStrings: [vstring(s, pixels)] })),
    }],
  };
}

function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}
function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let saved: Record<string, string | null> = {};
test.beforeEach(() => {
  saved = {};
  for (const p of [PLATFORM, CAPE_FILE, CAPE_INFO, PI_CONFIG]) saved[p] = read(p);
  write(PLATFORM, 'Raspberry Pi');
  write(CAPE_FILE, JSON.stringify(CAPE));
  write(CAPE_INFO, JSON.stringify({ id: 'FppTestsStrings', name: 'fpp-tests strings', version: '1.0', serialNumber: 'SN0001', provides: ['strings'] }));
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    if (content === null) inPlayer('rm', '-f', p); else write(p, content);
  }
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php?spixels');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}

const start = (page: Page, port: number) => page.locator(`#PixelString tr[id$="_Output_0_${port}_0"] input.vsStartChannel`);

test('strings whose channel ranges overlap are warned about, and only those', async ({ page }) => {
  // Regression: 881dd2863.  The overlap check was rewritten to work from the
  // values gathered once instead of reading every row from the page for each
  // pair; the warning is on the start channel of both strings, naming both
  // outputs.  Ports 1 and 2 (channels 1-150 and 101-250) overlap, port 3
  // (601-750) does not.
  write(PI_CONFIG, JSON.stringify(stringsConfig([0, 100, 600])));
  await openStrings(page);
  await expect(start(page, 1)).toHaveValue('101');
  await expect(start(page, 0)).toHaveClass(/inputWarning/);
  await expect(start(page, 1)).toHaveClass(/inputWarning/);
  await expect(start(page, 2)).not.toHaveClass(/inputWarning/);
  const title = (port: number) => start(page, port).getAttribute('data-bs-original-title');
  expect(await title(0)).toMatch(/Channels for outputs .* and .* overlap\./);
  expect(await title(1)).toBe(await title(0));
  expect(await title(2)).toBe('');

  // The control: the same strings spaced apart are not warned about.
  write(PI_CONFIG, JSON.stringify(stringsConfig([0, 300, 600])));
  await openStrings(page);
  await expect(start(page, 1)).toHaveValue('301');
  for (const port of [0, 1, 2]) await expect(start(page, port)).not.toHaveClass(/inputWarning/);
});

test('moving a string off another clears the overlap warning', async ({ page }) => {
  // Regression: 881dd2863.  The warnings are worked out again from the
  // fields on every change, and the old ones removed.
  write(PI_CONFIG, JSON.stringify(stringsConfig([0, 100, 600])));
  await openStrings(page);
  await expect(start(page, 1)).toHaveClass(/inputWarning/);
  await start(page, 1).fill('301');
  await start(page, 1).blur();
  await expect(start(page, 1)).not.toHaveClass(/inputWarning/);
  await expect(start(page, 0)).not.toHaveClass(/inputWarning/);
});
