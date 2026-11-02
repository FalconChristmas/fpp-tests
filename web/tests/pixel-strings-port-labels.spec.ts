import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The port labels and details on the Pixel Strings tab of a cape with smart
// (differential) receivers (see pixel-strings-smart-receivers.spec.ts, whose
// harness this repeats).

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_FILE = `${STRINGS_DIR}/FppTestsSmart.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsSmart', longName: 'fpp-tests smart receiver cape', numSerial: 0,
  supportsSmartReceivers: true,
  outputs: [{ pin: 'P8-08' }, { pin: 'P8-10' }, { pin: 'P8-12' }, { pin: 'P8-14' }],
  groups: [{ start: 1, count: 4, type: 'differential' }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsSmart', name: 'fpp-tests smart', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

function stringsConfig(differentialType: number) {
  const port = (portNumber: number, dt: number) => ({
    portNumber, protocol: 'ws2811', differentialType: dt,
    virtualStrings: [{
      description: `s${portNumber}`, startChannel: 1 + portNumber * 30, pixelCount: 10, groupCount: 0, reverse: 0,
      colorOrder: 'RGB', nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0',
    }],
  });
  return {
    channelOutputs: [{
      type: 'BBB48String', subType: 'FppTestsSmart', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: 4,
      outputs: [port(0, differentialType), port(1, 0), port(2, 0), port(3, 0)],
    }],
  };
}

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
  writeFile(CONFIG, JSON.stringify(stringsConfig(1)));
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

// The label cell at the start of each port's first string row.
const labels = (page: Page) => page.locator('#PixelString tr[id^="BBB48String_Output_0_"][id$="_0"] td.vsPortLabel').allInnerTexts();

test('going back from smart receivers to standard relabels all four ports of the group', async ({ page }) => {
  // Regression: 856b1fc3e (#1454).  Changing a differential port to Standard
  // only redrew the label of the port whose type was changed; the other
  // three kept the receiver letter they had been given ("2A)").
  await openStrings(page);
  expect(await labels(page), 'the control: as saved').toEqual(['1)', '2)', '3)', '4)']);
  await page.locator('#DifferentialType0').selectOption('2');
  await expect.poll(() => labels(page), { message: 'smart receivers add the letter' }).toEqual(['1A)', '2A)', '3A)', '4A)']);
  await page.locator('#DifferentialType0').selectOption('0');
  await expect.poll(() => labels(page)).toEqual(['1)', '2)', '3)', '4)']);
});

test("a port's details give its header pin after a space", async ({ page }) => {
  // Regression: 6f58bc687.  The details ran the port number into the pin:
  // "Port 1(P8-08)".
  // Also e7af8f5f4: the details are set on each port's label from that port's
  // own row; set from the first row for every label, each port named Port 1.
  await openStrings(page);
  const tip = (port: number) => page.locator('td.vsPortLabel').nth(port).getAttribute('data-bs-original-title', { timeout: 10_000 });
  await expect.poll(() => tip(0), { message: 'the tooltips are filled in' }).toContain('Port 1');
  expect(await tip(0)).toContain('Port 1 (P8-08)');
  expect(await tip(2)).toContain('Port 3 (P8-12)');
});
