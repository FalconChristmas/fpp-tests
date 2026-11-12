import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The LED Panels page's PWM register profiles and timing overrides, on a
// PocketBeagle2 with a BBShiftPanel cape (the harness is
// led-panels-pb2.spec.ts's).  A PWM driver chip takes a block of register
// words before it shows anything; FPP carries one set per chip, and this
// part of the page swaps in another from a capture catalog or a pasted line.
// The words go to the panel as they are saved, so what is refused, what is
// applied and what Save then writes are the things checked: a wrong word
// list is a dark panel.  (led-panel-profiles.spec.ts covers the two parsers
// as functions.)

test.skip(!container, 'changes the platform and php-fpm inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const OUTPUTS = '/home/fpp/media/config/channeloutputs.json';
const PANELS = '/home/fpp/media/tmp/panels';
const MODEL = '/tmp/fpp-tests-pb2-model';
const SO = '/tmp/fpp-tests-fakesys.so';

function restartPhpFpm(env: string) {
  inPlayer('sh', '-c',
    'm=$(cat /run/php/php8.4-fpm.pid 2>/dev/null); [ -n "$m" ] && kill -QUIT "$m"; ' +
    'for i in $(seq 50); do pgrep -x php-fpm8.4 > /dev/null || break; sleep 0.1; done; ' +
    `${env} php-fpm8.4 -R && ` +
    'for i in $(seq 50); do [ -S /run/php/php8.4-fpm.sock ] && break; sleep 0.1; done');
}

const matrix = (subType: string, over: object = {}) => ({
  cfgVersion: 3, type: 'LEDPanelMatrix', subType, panelMatrixID: 1, enabled: 1, startChannel: 1,
  channelCount: 6144, ledPanelsWidth: 64, ledPanelsHeight: 32, ledPanelsScan: 16, panelWidth: 64,
  panelHeight: 32, panelScan: 16, ledPanelsSize: '64x32x16', colorOrder: 'RGB', gamma: '2.2',
  brightness: 10, ledPanelsLayout: '1x1', ledPanelsOutputs: 8, ledPanelsPanelsPerOutput: 16,
  panelColorDepth: 8, invertedData: 0, panelOutputOrder: false, panelOutputBlankRow: false,
  panelRowAddressType: 0, panelType: 0, panelInterleave: '0', panelDataLayout: 0,
  panels: [{ outputNumber: 0, panelNumber: 0, colorOrder: '', xOffset: 0, yOffset: 0, orientation: 'N', row: 0, col: 0 }],
  ...over,
});

function cape(driver?: string) {
  inPlayer('sh', '-c', `rm -rf ${PANELS} && mkdir -p ${PANELS}`);
  putFile(`${PANELS}/FppTestsScroller.json`, JSON.stringify({
    name: 'FppTestsScroller', longName: 'fpp-tests panel cape', ...(driver ? { driver } : {}),
    defaults: { LEDPanelsConnection: driver ?? 'LEDscapeMatrix' }, controls: {},
    outputs: Array.from({ length: 8 }, () => ({})) }));
}

function writeOutputs(matrices: object[]) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({ channelOutputs: matrices }), OUTPUTS);
}
const saved = (request: APIRequestContext) => request.get('/api/configfile/channeloutputs.json').then((r) => r.json());

let savedPlatform = '';
let savedOutputs = '';
let savedPanels = '';
test.beforeAll(() => {
  inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', SO, '/tests/scenarios/fakesys.c', '-ldl');
  putFile(MODEL, 'BeagleBoard.org PocketBeagle2\0');
  // PHP resolves /proc/device-tree (a link to /sys/firmware/devicetree/base
  // where the kernel has one) before it opens the file: both are served.
  restartPhpFpm(`LD_PRELOAD=${SO} FAKESYS=/proc/device-tree/model=${MODEL}:/sys/firmware/devicetree/base/model=${MODEL}`);
});
test.afterAll(() => {
  restartPhpFpm('');
  inPlayer('rm', '-f', SO, MODEL);
});
test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  savedOutputs = inPlayer('sh', '-c', `cat ${OUTPUTS} 2>/dev/null || true`);
  savedPanels = inPlayer('sh', '-c', `cd ${PANELS} 2>/dev/null && tar cf - . | base64 -w0 || true`);
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone 64' > ${PLATFORM}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  if (savedOutputs) inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', savedOutputs, OUTPUTS);
  else inPlayer('rm', '-f', OUTPUTS);
  inPlayer('sh', '-c', `rm -rf ${PANELS}`);
  if (savedPanels.trim()) inPlayer('sh', '-c', `mkdir -p ${PANELS} && echo "$1" | base64 -d | tar xf - -C ${PANELS}`, 'sh', savedPanels.trim());
});

async function openPanels(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php#tab-LEDPanels');
  await page.locator('#tab-LEDPanels-tab').click();
  await expect(page.locator('#panelMatrix1 .LEDPanelsSize')).toBeAttached({ timeout: 15_000 });
}


const PWM = { panelType: 5 }; // FM6373: one of the chips whose registers come from a word list
const WORDS = { slot: 2, r: ['0001', '00a2', '00b3'], g: ['00ff', '0000', '0001'], b: ['0007', '0008', '0009'] };
const PAYLOAD = '2|1,a2,0B3|ff,0,1|7,8,9';
const CATALOG = [
  'RGBMATRIX_SPWM_PROFILES_V4\tFM6373\trgb\t3',
  `P5 indoor\tcapture-a\tScan_16, Scan_20\t${PAYLOAD}`,
  'P4 outdoor\tcapture-b\tScan_32\t3|10|20|30',
  'fixed type\tcapture-c\tScan_16\t1;2;3',
].join('\n');

async function openPwm(page: Page, over: object = PWM) {
  cape('BBShiftPanel');
  writeOutputs([matrix('BBShiftPanel', over)]);
  const flags: string[] = [];
  // Applying a profile raises the restart flag, a setting: kept off the player.
  await page.route((u) => u.pathname.includes('/api/settings/'), (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    flags.push(new URL(route.request().url()).pathname.replace(/\/$/, '').split('/').pop()!);
    return route.fulfill({ json: { status: 'OK' } });
  });
  await openPanels(page);
  return { m: page.locator('#panelMatrix1'), flags };
}
async function importPanel(page: Page, over: object = PWM) {
  const { m, flags } = await openPwm(page, over);
  await m.locator('.PWMRegProfileToggle').click();
  await expect(m.locator('.PWMRegProfilePanel')).toBeVisible();
  return { m, flags };
}
const loadCatalog = (m: ReturnType<Page['locator']>, text: string, name = 'fm6373.profiles') =>
  m.locator('.PWMRegProfileFile').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

async function saveMatrix(page: Page, request: APIRequestContext, done: (o: any) => boolean) {
  await page.locator('#tab-LEDPanels input[type=button][value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => done((await saved(request)).channelOutputs[0]), { timeout: 15_000 }).toBe(true);
  return (await saved(request)).channelOutputs[0];
}

test.describe('the register profile row', () => {
  test('is offered for the chips that take a word list, and not for the others', async ({ page }) => {
    const { m } = await openPwm(page, { panelType: 0 });
    const rows = m.locator('.PWMRegProfileRow');
    await expect(rows).toHaveCount(3);
    for (const [type, shown] of [['0', false], ['5', true], ['3', false], ['7', true], ['8', true], ['9', false]] as const) {
      await m.locator('.LEDPanelsType').selectOption(type);
      for (let i = 0; i < 3; i++) await (shown ? expect(rows.nth(i)).toBeVisible() : expect(rows.nth(i)).toBeHidden());
    }
  });

  test('says the built-in table is in use until something is imported, and Import opens and closes the panel', async ({ page }) => {
    const { m } = await openPwm(page);
    await expect(m.locator('.PWMRegProfileName')).toHaveText('Built-in default');
    await expect(m.locator('.PWMRegProfilePanel')).toBeHidden();
    await m.locator('.PWMRegProfileToggle').click();
    await expect(m.locator('.PWMRegProfilePanel')).toBeVisible();
    await expect(m.locator('.PWMRegProfileSelect option')).toHaveText(['(load a catalog above)']);
    await m.locator('.PWMRegProfileToggle').click();
    await expect(m.locator('.PWMRegProfilePanel')).toBeHidden();
  });

  test('shows a saved profile by name, and Save writes it back word for word', async ({ page, request }) => {
    const panelRegisters = { profile: 'P5 indoor', ...WORDS };
    const { m } = await openPwm(page, { ...PWM, panelRegisters, brightness: 10 });
    await expect(m.locator('.PWMRegProfileName')).toHaveText('P5 indoor (3 words/color)');
    await m.locator('.LEDPanelsBrightness').selectOption('7');
    const now = await saveMatrix(page, request, (o) => o.brightness == 7);
    expect(now.panelRegisters).toEqual(panelRegisters);
    expect(now.panelType).toBe(5);
  });

  test('Use Built-in drops a saved profile from the config at the next Save', async ({ page, request }) => {
    const { m, flags } = await openPwm(page, { ...PWM, panelRegisters: { profile: 'P5 indoor', ...WORDS } });
    await m.locator('.PWMRegProfileToggle').click();
    await m.locator('.PWMRegProfileClear').click();
    await expect(m.locator('.PWMRegProfileName')).toHaveText('Built-in default');
    await expect(m.locator('.PWMRegProfileMsg')).toHaveText('Back to the built-in table. Save to apply.');
    expect(flags).toContain('restartFlag');
    // Not until Save.
    expect((await saved(request)).channelOutputs[0]).toHaveProperty('panelRegisters');
    await m.locator('.LEDPanelsBrightness').selectOption('7');
    const now = await saveMatrix(page, request, (o) => o.brightness == 7);
    expect(now).not.toHaveProperty('panelRegisters');
  });
});

test.describe('a pasted profile', () => {
  test('of nothing is refused', async ({ page }) => {
    const { m } = await importPanel(page);
    await m.locator('.PWMRegProfileApplyPaste').click();
    await expect(m.locator('.PWMRegProfileMsg')).toHaveText('Paste a profile line or payload first.');
    await expect(m.locator('.PWMRegProfileName')).toHaveText('Built-in default');
  });

  for (const [what, text] of [
    ['the "fixed" payload type', '1;2;3'],
    ['colours with different word counts', '2|1,2|3|4,5'],
    ['a slot that does not exist', '9|1|2|3'],
    ['a word that is not hex', '2|1|zz|3'],
  ] as const) {
    test(`that is ${what} is refused, and Save writes no profile`, async ({ page, request }) => {
      const { m, flags } = await importPanel(page);
      await m.locator('.PWMRegProfilePaste').fill(text);
      await m.locator('.PWMRegProfileApplyPaste').click();
      await expect(m.locator('.PWMRegProfileMsg')).toContainText('That is not an rgb profile payload.');
      await expect(m.locator('.PWMRegProfileMsg')).toContainText('slot|R-words|G-words|B-words');
      await expect(m.locator('.PWMRegProfileName')).toHaveText('Built-in default');
      expect(flags).not.toContain('restartFlag');
      await m.locator('.LEDPanelsBrightness').selectOption('7');
      const now = await saveMatrix(page, request, (o) => o.brightness == 7);
      expect(now).not.toHaveProperty('panelRegisters');
    });
  }

  test('that is a bare payload is applied as "pasted", each word made four lower-case hex digits, and saved', async ({ page, request }) => {
    const { m, flags } = await importPanel(page);
    await m.locator('.PWMRegProfilePaste').fill(`  ${PAYLOAD}\n`);
    await m.locator('.PWMRegProfileApplyPaste').click();
    await expect(m.locator('.PWMRegProfileMsg')).toHaveText('Applied pasted (3 words per color). Save to send it to the panel.');
    await expect(m.locator('.PWMRegProfileName')).toHaveText('pasted (3 words/color)');
    // The panel only takes new registers when fppd restarts.
    expect(flags).toContain('restartFlag');
    const now = await saveMatrix(page, request, (o) => !!o.panelRegisters);
    expect(now.panelRegisters).toEqual({ profile: 'pasted', ...WORDS });
  });

  test('that is a whole catalog line is applied under the name on the line', async ({ page, request }) => {
    const { m } = await importPanel(page);
    await m.locator('.PWMRegProfilePaste').fill(`P5 indoor\tcapture-a\tScan_16\t${PAYLOAD}`);
    await m.locator('.PWMRegProfileApplyPaste').click();
    await expect(m.locator('.PWMRegProfileName')).toHaveText('P5 indoor (3 words/color)');
    const now = await saveMatrix(page, request, (o) => !!o.panelRegisters);
    expect(now.panelRegisters).toEqual({ profile: 'P5 indoor', ...WORDS });
  });

  test('whose name has markup in it is shown as text', async ({ page }) => {
    const { m } = await importPanel(page);
    await m.locator('.PWMRegProfilePaste').fill(`<img src=x onerror="window.__profile=1">\tcapture\tScan_16\t${PAYLOAD}`);
    await m.locator('.PWMRegProfileApplyPaste').click();
    await expect(m.locator('.PWMRegProfileName')).toContainText('3 words/color');
    test.fail(true, 'the profile name is written into the row and the message as HTML (FUTURE.md)');
    await expect(m.locator('.PWMRegProfileName img, .PWMRegProfileMsg img')).toHaveCount(0);
  });
});

test.describe('a capture catalog', () => {
  test('is listed with the profiles captured at this panel\'s scan rate first, and the unusable lines left out', async ({ page }) => {
    const { m } = await importPanel(page);
    await loadCatalog(m, CATALOG);
    await expect(m.locator('.PWMRegProfileMsg')).toHaveText('Loaded 2 profiles.');
    await expect(m.locator('.PWMRegProfileCount')).toContainText('FM6373: 2 profiles, 1 at 1/16');
    const groups = m.locator('.PWMRegProfileSelect optgroup');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toHaveAttribute('label', 'Captured at 1/16 (1)');
    await expect(groups.nth(1)).toHaveAttribute('label', 'Other scan rates (1)');
    await expect(groups.nth(0).locator('option')).toHaveText(['P5 indoor — capture-a']);
    await expect(groups.nth(1).locator('option')).toHaveText(['P4 outdoor — capture-b']);
  });

  test('profile that is picked and applied is the one Save writes', async ({ page, request }) => {
    const { m } = await importPanel(page);
    await loadCatalog(m, CATALOG);
    await expect(m.locator('.PWMRegProfileSelect optgroup')).toHaveCount(2);
    await m.locator('.PWMRegProfileSelect').selectOption({ label: 'P4 outdoor — capture-b' });
    await m.locator('.PWMRegProfileApplySel').click();
    await expect(m.locator('.PWMRegProfileMsg')).toHaveText('Applied P4 outdoor (1 words per color). Save to send it to the panel.');
    await expect(m.locator('.PWMRegProfileName')).toHaveText('P4 outdoor (1 words/color)');
    const now = await saveMatrix(page, request, (o) => !!o.panelRegisters);
    expect(now.panelRegisters).toEqual({ profile: 'P4 outdoor', slot: 3, r: ['0010'], g: ['0020'], b: ['0030'] });
  });

  test('made for another chip loads, with a warning naming both chips', async ({ page }) => {
    const { m } = await importPanel(page, { panelType: 7 });
    await loadCatalog(m, CATALOG);
    await expect(m.locator('.PWMRegProfileMsg')).toHaveText('Loaded, but this catalog is for FM6373 and the panel type is set to icnd1065l.');
    await expect(m.locator('.PWMRegProfileSelect optgroup')).toHaveCount(2);
  });

  for (const [what, text, why] of [
    ['is not a catalog', 'P5 indoor\tcapture-a\tScan_16\t2|1|2|3\n', 'not a .profiles catalog (bad header)'],
    ['is empty', '\n\n', 'file is empty'],
    ['holds only "fixed" profiles', 'RGBMATRIX_SPWM_PROFILES_V4\tFM6353C\tfixed\t1\nfixed\tcapture\tScan_16\t1;2;3\n', 'no usable rgb profiles in this catalog'],
  ] as const) {
    test(`file that ${what} is refused with the reason, and replaces a catalog already loaded with nothing`, async ({ page }) => {
      const { m } = await importPanel(page);
      await loadCatalog(m, CATALOG);
      await expect(m.locator('.PWMRegProfileSelect optgroup')).toHaveCount(2);
      await loadCatalog(m, text, 'other.profiles');
      await expect(m.locator('.PWMRegProfileMsg')).toHaveText(`Could not read that file: ${why}`);
      await expect(m.locator('.PWMRegProfileSelect option')).toHaveText(['(load a catalog above)']);
      // Nothing left to apply.
      await m.locator('.PWMRegProfileApplySel').click();
      await expect(m.locator('.PWMRegProfileMsg')).toHaveText('Load a catalog and pick a profile first.');
      await expect(m.locator('.PWMRegProfileName')).toHaveText('Built-in default');
    });
  }
});

test.describe('the register upload and OE timing overrides', () => {
  const FIELDS = {
    LEDPanelsRegVsyncClocks: 'panelRegVsyncClocks', LEDPanelsRegMidClocks: 'panelRegMidClocks',
    LEDPanelsRegPreClocks: 'panelRegPreClocks', LEDPanelsRegSpacerClocks: 'panelRegSpacerClocks',
    LEDPanelsOEClkLength: 'panelOEClkLength', LEDPanelsOEFirstClkLength: 'panelOEFirstClkLength',
    LEDPanelsOERowPeriodUs: 'panelOERowPeriodUs',
  };

  test('left blank are left out of the config, so fppd keeps its own timing', async ({ page, request }) => {
    const { m } = await openPwm(page);
    for (const cls of Object.keys(FIELDS)) await expect(m.locator(`.${cls}`)).toHaveValue('');
    await m.locator('.LEDPanelsBrightness').selectOption('7');
    const now = await saveMatrix(page, request, (o) => o.brightness == 7);
    for (const key of Object.values(FIELDS)) expect(now, key).not.toHaveProperty(key);
  });

  test('typed are saved as numbers, a zero included, and shown again on the next visit', async ({ page, request }) => {
    const { m } = await openPwm(page);
    const typed: Record<string, string> = {
      LEDPanelsRegVsyncClocks: '4', LEDPanelsRegMidClocks: '0', LEDPanelsRegPreClocks: '15', LEDPanelsRegSpacerClocks: '0',
      LEDPanelsOEClkLength: '6', LEDPanelsOEFirstClkLength: '13', LEDPanelsOERowPeriodUs: '25',
    };
    for (const [cls, v] of Object.entries(typed)) await m.locator(`.${cls}`).fill(v);
    const now = await saveMatrix(page, request, (o) => o.panelRegVsyncClocks === 4);
    expect(Object.fromEntries(Object.values(FIELDS).map((k) => [k, now[k]]))).toEqual({
      panelRegVsyncClocks: 4, panelRegMidClocks: 0, panelRegPreClocks: 15, panelRegSpacerClocks: 0,
      panelOEClkLength: 6, panelOEFirstClkLength: 13, panelOERowPeriodUs: 25,
    });
    await page.reload();
    await page.locator('#tab-LEDPanels-tab').click();
    for (const [cls, v] of Object.entries(typed)) await expect(page.locator(`#panelMatrix1 .${cls}`)).toHaveValue(v, { timeout: 15_000 });
  });

  test('cleared again are taken back out of the config', async ({ page, request }) => {
    const { m } = await openPwm(page, { ...PWM, panelOEClkLength: 6, panelRegMidClocks: 0 });
    await expect(m.locator('.LEDPanelsOEClkLength')).toHaveValue('6');
    await expect(m.locator('.LEDPanelsRegMidClocks')).toHaveValue('0');
    await m.locator('.LEDPanelsOEClkLength').fill('');
    await m.locator('.LEDPanelsBrightness').selectOption('7');
    const now = await saveMatrix(page, request, (o) => o.brightness == 7);
    expect(now).not.toHaveProperty('panelOEClkLength');
    expect(now.panelRegMidClocks).toBe(0);
  });
});
