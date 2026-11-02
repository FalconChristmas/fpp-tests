import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Pixel Strings tab on a cape whose second port shares the first port's
// header pin (an output with "sharedOutput" in the cape's description); see
// pixel-strings-more.spec.ts, whose harness this repeats.

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_FILE = `${STRINGS_DIR}/FppTestsShared.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsShared', longName: 'fpp-tests shared output cape', numSerial: 0,
  outputs: [{ pin: 'P8-08' }, { sharedOutput: 0 }, { pin: 'P8-12' }],
  groups: [{ start: 1, count: 3 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsShared', name: 'fpp-tests shared', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

const STRINGS_CONFIG = {
  channelOutputs: [{
    type: 'BBB48String', subType: 'FppTestsShared', pinoutVersion: '1.x', enabled: 1,
    startChannel: 1, channelCount: -1, outputCount: 3,
    outputs: [0, 1, 2].map((portNumber) => ({
      portNumber, protocol: 'ws2811', differentialType: 0,
      virtualStrings: [{
        description: `s${portNumber}`, startChannel: 1 + portNumber * 30, pixelCount: 10, groupCount: 0, reverse: 0,
        colorOrder: 'RGB', nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
      }],
    })),
  }],
};

function writeFile(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}

function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

function putBack(path: string, content: string | null) {
  if (content === null) {
    inPlayer('rm', '-f', path);
  } else {
    writeFile(path, content);
  }
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
    putBack(p, content);
  }
});

async function openStrings(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
}

test("a port that shares another's output names that output's header pin", async ({ page }) => {
  // Regression: 355a0111d.  A shared output has no pin of its own in the
  // cape's description, so the port's details (its tooltip) named it
  // "UNKNOWN PIN!" instead of the pin it shares.
  await openStrings(page);
  const tip = async (port: number) => page.locator('td.vsPortLabel').nth(port).getAttribute('data-bs-original-title', { timeout: 10_000 });
  await expect.poll(() => tip(0), { message: 'the tooltips are filled in' }).toContain('Port 1');
  // The control: ports with a pin of their own.
  expect(await tip(0)).toContain('P8-08');
  expect(await tip(2)).toContain('P8-12');
  const shared = await tip(1);
  expect(shared).toContain('Port 2');
  expect(shared, 'the shared port had no pin').not.toContain('UNKNOWN PIN');
  expect(shared).toContain('P8-08');
});
