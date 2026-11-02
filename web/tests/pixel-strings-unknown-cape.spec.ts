import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Pixel Strings tab where the cape does not name the layout (see pixel-strings-more.spec.ts, whose harness this
// repeats): on a BeagleBone with a two-port string cape.  The tab is drawn only on a player that can drive strings, and
// the page decides that from /etc/fpp/platform (config.php), so the test
// player claims to be a BeagleBone for the length of each test.  The cape is
// put where cape detection unpacks it from the EEPROM: media/tmp/cape-info.json
// (signed, so all its ports are licensed for more than 50 pixels) and its
// string layout in media/tmp/strings.  fppd, already running, is not
// affected: it reads the string config only at start, and has no BeagleBone
// string driver here.

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
// Any key but the FPP project's own ("fp") licenses every port.
const CAPE_INFO_JSON = {
  id: 'FppTestsStrings', name: 'fpp-tests strings', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], verifiedKeyId: 'ft',
};

function vstring(description: string, startChannel: number, pixelCount: number, extra: Record<string, unknown> = {}) {
  return {
    description, startChannel, pixelCount, groupCount: 0, reverse: 0, colorOrder: 'RGB',
    nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0', ...extra,
  };
}

function stringsConfig(port0: object[], port1: object[]) {
  return {
    channelOutputs: [{
      type: 'BBB48String', subType: 'FppTestsStrings', pinoutVersion: '1.x', enabled: 1,
      startChannel: 1, channelCount: -1, outputCount: 2,
      outputs: [
        { portNumber: 0, protocol: 'ws2811', differentialType: 0, virtualStrings: port0 },
        { portNumber: 1, protocol: 'ws2811', differentialType: 0, virtualStrings: port1 },
      ],
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
});

test.afterEach(() => {
  for (const [p, content] of Object.entries(saved)) {
    putBack(p, content);
  }
});


test('a saved string config whose cape layout is unknown draws every saved port', async ({ page }) => {
  // Regression: a37a55827.  The port count came from the cape layout and,
  // with none, was 4: a config of six ports showed four and a Save dropped
  // the other two.  With no layout the saved config's own count is used.
  const ports = (n: number) => Array.from({ length: n }, (_, i) => ({
    portNumber: i, protocol: 'ws2811', differentialType: 0, virtualStrings: [vstring(`p${i}`, i * 150, 50)],
  }));
  writeFile(CONFIG, JSON.stringify({ channelOutputs: [{
    type: 'BBB48String', subType: 'NoSuchCapeLayout', pinoutVersion: '1.x', enabled: 1,
    startChannel: 1, channelCount: -1, outputCount: 6, outputs: ports(6),
  }] }));
  inPlayer('rm', '-f', CAPE_FILE);
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#stringTab-tab').click();
  await expect(page.locator('#PixelString_enable')).toBeChecked({ timeout: 15_000 });
  await expect(page.locator('#PixelString tr[id*="_Output_0_"][id$="_0"]')).toHaveCount(6);
});

test('the Pixel Strings tab is drawn, hidden, for a cape that provides only panels', async ({ page }) => {
  // Regression: a37a55827.  The tab was left out of the page altogether when
  // the cape did not provide strings, though the page's script and a
  // configuration that had Pixel Strings enabled still addressed it.
  writeFile(CAPE_INFO, JSON.stringify({ ...CAPE_INFO_JSON, provides: ['panels'] }));
  await page.goto('/channeloutputs.php');
  const li = page.locator('#tab-strings-LI');
  await expect(li).toBeAttached({ timeout: 15_000 });
  await expect(li).toHaveClass(/hidden/);
  await expect(page.locator('#stringTab')).toBeAttached();
});
