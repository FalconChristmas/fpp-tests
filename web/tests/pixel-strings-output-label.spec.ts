import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// A cape file whose outputs carry their own "label" (see
// pixel-strings-port-labels.spec.ts, whose harness this repeats).

test.skip(!container, 'changes the platform and config inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MEDIA = '/home/fpp/media';
const STRINGS_DIR = `${MEDIA}/tmp/strings`;
const CAPE_FILE = `${STRINGS_DIR}/FppTestsOutLabel.json`;
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const CONFIG = `${MEDIA}/config/co-bbbStrings.json`;

const CAPE = {
  name: 'FppTestsOutLabel', longName: 'fpp-tests smart receiver cape', numSerial: 0,
  outputs: [{ pin: 'P8-08', label: 'A' }, { pin: 'P8-10' }, { pin: 'P8-12', label: 'C' }, { pin: 'P8-14' }],
  groups: [{ start: 1, count: 4, type: 'standard', portStart: 11 }],
};
const CAPE_INFO_JSON = {
  id: 'FppTestsOutLabel', name: 'fpp-tests smart', version: '1.0', serialNumber: 'SN0001',
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
      type: 'BBB48String', subType: 'FppTestsOutLabel', pinoutVersion: '1.x', enabled: 1,
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
  writeFile(CONFIG, JSON.stringify(stringsConfig(0)));
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

test('an output that supplies its own label shows it instead of its position', async ({ page }) => {
  // Regression: 0a95e7462.  A cape file can give an output a "label" (to skip
  // pins that are not wired); the port label ignored it and numbered the
  // port by its position.  Outputs without one keep the group's numbering.
  await openStrings(page);
  expect(await labels(page)).toEqual(['A)', '12)', 'C)', '14)']);
});
