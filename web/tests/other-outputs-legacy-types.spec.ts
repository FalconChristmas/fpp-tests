import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Other outputs that co-other.php still draws itself (Renard, LOR, DMX,
// Pixelnet, Generic Serial, USB Relay, the HTTP Virtual Display, MAX7219 and
// nRF), as opposed to the ones an output module draws.  Save rebuilds
// co-other.json from what is on the page, every tab at once, so a field the
// page does not read back is a field Save removes: the file is the receiving
// end throughout.
//
// The outputs are saved disabled, so fppd reloads the file and opens nothing.

test.skip(!container, "changes the player's output config and adds a device node");

// A stand-in serial port: a file of that name in /dev is all the page asks.
const PORT = 'ttyS77';

const saved = [
  { type: 'Renard', enabled: 0, startChannel: 1, channelCount: 286, device: PORT, description: 'arches', renardspeed: 115200, renardparm: '8N2' },
  { type: 'LOR', enabled: 0, startChannel: 300, channelCount: 32, device: PORT, description: 'lor box', speed: 57600, firstControllerId: 5 },
  { type: 'DMX-Pro', enabled: 0, startChannel: 400, channelCount: 512, device: PORT, description: 'movers' },
  { type: 'Pixelnet-Open', enabled: 0, startChannel: 1000, channelCount: 4096, device: PORT, description: 'pn' },
  { type: 'GenericSerial', enabled: 0, startChannel: 6000, channelCount: 4, device: PORT, description: 'gs', speed: 38400, header: 'AB', footer: 'CD' },
  { type: 'USBRelay', enabled: 0, startChannel: 7000, channelCount: 8, device: PORT, subType: 'CH340', relayCount: 8 },
  { type: 'HTTPVirtualDisplay', enabled: 0, startChannel: 1, channelCount: 8388608, width: 640, height: 480, pixelSize: 3, updateInterval: 50 },
  { type: 'MAX7219Matrix', enabled: 0, startChannel: 8000, channelCount: 384, panels: 2, channelsPerPixel: 3 },
  { type: 'SPI-nRF24L01', enabled: 0, startChannel: 9000, channelCount: 512, speed: 1, channel: 76 },
];

type Output = Record<string, unknown> & { type: string };
const byType = (outputs: Output[]) => [...outputs].sort((a, b) => a.type.localeCompare(b.type));

async function stored(request: APIRequestContext): Promise<Output[]> {
  return JSON.parse(await (await request.get('/api/channel/output/co-other')).text()).channelOutputs;
}

let before: string | null = null;
test.beforeEach(async ({ request }) => {
  inPlayer('touch', `/dev/${PORT}`);
  const r = await request.get('/api/channel/output/co-other');
  before = r.ok() ? await r.text() : null;
  const w = await request.post('/api/channel/output/co-other', { data: { channelOutputs: saved } });
  expect(w.ok(), await w.text()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/channel/output/co-other', { data: Buffer.from(before ?? '{"channelOutputs": []}') });
  inPlayer('rm', '-f', `/dev/${PORT}`);
});

async function open(page: Page) {
  await page.goto('/channeloutputs.php?t=' + Date.now());
  await expect(page.locator('#tblOther-DMXSerial > tbody > tr')).toHaveCount(5, { timeout: 15_000 });
}
const tab = (page: Page, category: string) => page.locator(`#tab-other-${category}-tab`);
const rows = (page: Page, category: string) => page.locator(`#tblOther-${category} > tbody > tr`);
const row = (page: Page, category: string, type: string) =>
  page.locator(`#tblOther-${category} > tbody > tr`).filter({ has: page.locator(`input.type[value="${type}"]`) });
// The pinned table header keeps a hidden copy of the buttons.
const save = (page: Page, category: string) =>
  page.locator(`#tab-other-${category} input[value="Save"]:not(.Zebra_Pin_Clone *)`);
const add = (page: Page, category: string) =>
  page.locator(`#tab-other-${category} button:has-text("Add"):not(.Zebra_Pin_Clone *)`);

async function saveAndWait(page: Page, category: string) {
  const posted = page.waitForResponse((r) => r.url().includes('/api/channel/output/co-other') && r.request().method() === 'POST');
  await save(page, category).click();
  expect((await posted).ok()).toBe(true);
}

test('every output is shown as saved, and saving the page untouched writes the same outputs back', async ({ page, request }) => {
  await open(page);
  await expect(rows(page, 'ControlSignal')).toHaveCount(1);
  await expect(rows(page, 'VirtualDisplay')).toHaveCount(1);
  await expect(rows(page, 'SPI')).toHaveCount(2);

  await tab(page, 'DMXSerial').click();
  const renard = row(page, 'DMXSerial', 'Renard');
  await expect(renard.locator('select.device')).toHaveValue(PORT);
  await expect(renard.locator('select.renardspeed')).toHaveValue('115200');
  await expect(renard.locator('select.renardparm')).toHaveValue('8N2');
  await expect(renard.locator('input.description')).toHaveValue('arches');
  const lor = row(page, 'DMXSerial', 'LOR');
  await expect(lor.locator('select.speed')).toHaveValue('57600');
  await expect(lor.locator('input.firstControllerId')).toHaveValue('5');
  const serial = row(page, 'DMXSerial', 'GenericSerial');
  await expect(serial.locator('select.speed')).toHaveValue('38400');
  await expect(serial.locator('input.serialheader')).toHaveValue('AB');
  await expect(serial.locator('input.serialfooter')).toHaveValue('CD');
  // Channel counts the type fixes cannot be typed over.
  await expect(row(page, 'DMXSerial', 'Pixelnet-Open').locator('input.count')).toBeDisabled();
  await expect(row(page, 'DMXSerial', 'DMX-Pro').locator('input.count')).toBeEnabled();

  await tab(page, 'ControlSignal').click();
  const relay = row(page, 'ControlSignal', 'USBRelay');
  await expect(relay.locator('select.subType')).toHaveValue('CH340');
  await expect(relay.locator('select.relayCount')).toHaveValue('8');
  await expect(relay.locator('input.count')).toBeDisabled();

  await tab(page, 'VirtualDisplay').click();
  const display = row(page, 'VirtualDisplay', 'HTTPVirtualDisplay');
  await expect(display.locator('input.width')).toHaveValue('640');
  await expect(display.locator('input.height')).toHaveValue('480');
  await expect(display.locator('select.pixelSize')).toHaveValue('3');
  await expect(display.locator('input.updateInterval')).toHaveValue('50');
  await expect(display.locator('input.start')).toBeDisabled();

  await tab(page, 'SPI').click();
  const matrix = row(page, 'SPI', 'MAX7219Matrix');
  await expect(matrix.locator('input.panels')).toHaveValue('2');
  await expect(matrix.locator('select.channelsPerPixel')).toHaveValue('3');
  const nrf = row(page, 'SPI', 'SPI-nRF24L01');
  await expect(nrf.locator('select.speed')).toHaveValue('1');
  await expect(nrf.locator('input.channel')).toHaveValue('76');
  await expect(nrf).toContainText('Deprecated');

  // Saved from the last tab: one Save writes every tab.
  await saveAndWait(page, 'SPI');
  expect(byType(await stored(request))).toEqual(byType(saved));
  // The tab the Save was pressed on is the one still showing.
  await expect(tab(page, 'SPI')).toHaveClass(/active/);
});

test('what is changed on each row is what the file holds afterwards', async ({ page, request }) => {
  await open(page);
  await tab(page, 'DMXSerial').click();
  const renard = row(page, 'DMXSerial', 'Renard');
  await renard.locator('select.renardspeed').selectOption('230400');
  await renard.locator('select.renardparm').selectOption('8N1');
  await renard.locator('input.act').check();
  const lor = row(page, 'DMXSerial', 'LOR');
  await lor.locator('select.speed').selectOption('115200');
  await lor.locator('input.firstControllerId').fill('17');
  const serial = row(page, 'DMXSerial', 'GenericSerial');
  await serial.locator('input.serialheader').fill('<<');
  await serial.locator('input.serialfooter').fill('>>');
  await serial.locator('input.description').fill('sign');

  // Fewer relays is fewer channels, and more panels more: the page keeps the
  // count, which cannot be typed, in step.
  await tab(page, 'ControlSignal').click();
  const relay = row(page, 'ControlSignal', 'USBRelay');
  await relay.locator('select.relayCount').selectOption('4');
  await relay.locator('select.subType').selectOption('Bit');
  await expect(relay.locator('input.count')).toHaveValue('4');

  await tab(page, 'SPI').click();
  const matrix = row(page, 'SPI', 'MAX7219Matrix');
  await matrix.locator('input.panels').fill('4');
  await matrix.locator('input.panels').blur();
  await expect(matrix.locator('input.count')).toHaveValue('768');
  await matrix.locator('select.channelsPerPixel').selectOption('1');
  await expect(matrix.locator('input.count')).toHaveValue('256');
  const nrf = row(page, 'SPI', 'SPI-nRF24L01');
  await nrf.locator('select.speed').selectOption('0');
  await nrf.locator('input.channel').fill('12');

  await tab(page, 'VirtualDisplay').click();
  const display = row(page, 'VirtualDisplay', 'HTTPVirtualDisplay');
  await display.locator('input.width').fill('1920');
  await display.locator('input.height').fill('1080');
  await display.locator('select.pixelSize').selectOption('1');
  await display.locator('input.updateInterval').fill('40');

  await saveAndWait(page, 'VirtualDisplay');
  const now = Object.fromEntries((await stored(request)).map((o) => [o.type, o]));
  expect(now['Renard']).toMatchObject({ enabled: 1, renardspeed: 230400, renardparm: '8N1', device: PORT, description: 'arches' });
  expect(now['LOR']).toMatchObject({ speed: 115200, firstControllerId: 17, channelCount: 32 });
  expect(now['GenericSerial']).toMatchObject({ header: '<<', footer: '>>', description: 'sign', speed: 38400 });
  expect(now['USBRelay']).toMatchObject({ relayCount: 4, subType: 'Bit', channelCount: 4, device: PORT });
  expect(now['MAX7219Matrix']).toMatchObject({ panels: 4, channelsPerPixel: 1, channelCount: 256 });
  expect(now['SPI-nRF24L01']).toMatchObject({ speed: 0, channel: 12 });
  expect(now['HTTPVirtualDisplay']).toMatchObject({ width: 1920, height: 1080, pixelSize: 1, updateInterval: 40 });
  // Rows nobody touched are as they were.
  expect(now['DMX-Pro']).toEqual(saved.find((o) => o.type === 'DMX-Pro'));
  expect(now['Pixelnet-Open']).toEqual(saved.find((o) => o.type === 'Pixelnet-Open'));
});

test('a deleted row is gone from the file, the rows after it are renumbered, and the other tabs keep theirs', async ({ page, request }) => {
  await open(page);
  await tab(page, 'DMXSerial').click();
  const remove = page.locator('#btnDeleteOther-DMXSerial:not(.Zebra_Pin_Clone *)');
  await row(page, 'DMXSerial', 'LOR').locator('td').first().click();
  await expect(remove).toHaveClass(/btn-outline-danger/);
  await remove.click();

  await expect(rows(page, 'DMXSerial')).toHaveCount(4);
  await expect(rows(page, 'DMXSerial').locator('td:first-child')).toHaveText(['1', '2', '3', '4']);
  // Nothing is selected any more, so Delete is off again.
  await expect(remove).not.toHaveClass(/btn-outline-danger/);
  // Not until Save.
  expect(await stored(request)).toHaveLength(saved.length);

  await saveAndWait(page, 'DMXSerial');
  expect(byType(await stored(request))).toEqual(byType(saved.filter((o) => o.type !== 'LOR')));
});

test.describe('refused saves leave the file alone', () => {
  async function refused(page: Page, request: APIRequestContext, category: string, message: string | RegExp) {
    let posts = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/channel/output/co-other') && r.method() === 'POST') posts++;
    });
    await save(page, category).click();
    await expect(page.locator('#dialogOKPopup')).toContainText(message);
    expect(posts, 'nothing was posted').toBe(0);
    expect(byType(await stored(request))).toEqual(byType(saved));
  }

  test('a start channel and count that run past the last channel', async ({ page, request }) => {
    await open(page);
    await tab(page, 'DMXSerial').click();
    const max = await page.evaluate(() => (window as any).FPPD_MAX_CHANNELS as number);
    const renard = row(page, 'DMXSerial', 'Renard');
    await renard.locator('input.start').fill(String(max - 100));
    await refused(page, request, 'DMXSerial', `Start Channel '${max - 100}' plus Channel Count '286' exceeds ${max} on row 1`);

    // The control: one channel fewer than the limit ends on it, and saves.
    await page.locator('#dialogOKPopup button', { hasText: 'Close' }).click();
    await renard.locator('input.start').fill(String(max - 285));
    await saveAndWait(page, 'DMXSerial');
    expect((await stored(request)).find((o) => o.type === 'Renard')!.startChannel).toBe(max - 285);
  });

  test('a new row whose type was never chosen', async ({ page, request }) => {
    await open(page);
    await tab(page, 'DMXSerial').click();
    await add(page, 'DMXSerial').click();
    await expect(rows(page, 'DMXSerial')).toHaveCount(6);
    await refused(page, request, 'DMXSerial', 'Output type must be selected on row 6');
  });

  for (const [category, type, label, message] of [
    ['DMXSerial', 'Renard', 'Renard', 'Invalid Renard Config'],
    ['DMXSerial', 'LOR', 'LOR', 'Invalid LOR Config'],
    ['DMXSerial', 'DMX-Open', 'DMX-Open', 'Invalid Output Config'],
    ['DMXSerial', 'GenericSerial', 'Generic Serial', 'Invalid Generic Serial Config'],
    ['ControlSignal', 'USBRelay', 'USBRelay', 'Invalid USBRelay Config'],
  ] as const) {
    test(`a new ${label} output with no port chosen`, async ({ page, request }) => {
      await open(page);
      await tab(page, category).click();
      await add(page, category).click();
      await page.locator(`#outputType-${category}`).selectOption(type);
      const fresh = rows(page, category).last();
      await expect(fresh.locator('select.device')).toHaveValue('');
      await refused(page, request, category, message);

      // The control: with the port chosen the same row saves.
      await page.locator('#dialogOKPopup button', { hasText: 'Close' }).click();
      await fresh.locator('select.device').selectOption(PORT);
      await saveAndWait(page, category);
      const now = await stored(request);
      expect(now).toHaveLength(saved.length + 1);
      expect(now.filter((o) => o.type === type).pop()).toMatchObject({ device: PORT, enabled: 0, startChannel: 1 });
    });
  }

  test('a virtual display with no width, or no height', async ({ page, request }) => {
    await open(page);
    await tab(page, 'VirtualDisplay').click();
    const display = row(page, 'VirtualDisplay', 'HTTPVirtualDisplay');
    await display.locator('input.width').fill('');
    await refused(page, request, 'VirtualDisplay', 'Invalid HTTPVirtual Display Config');
    await page.locator('#dialogOKPopup button', { hasText: 'Close' }).click();
    await display.locator('input.width').fill('640');
    await display.locator('input.height').fill('');
    await refused(page, request, 'VirtualDisplay', 'Invalid HTTPVirtual Display Config');
  });

  test('a MAX7219 matrix with no panel count', async ({ page, request }) => {
    await open(page);
    await tab(page, 'SPI').click();
    await row(page, 'SPI', 'MAX7219Matrix').locator('input.panels').evaluate((e: HTMLInputElement) => (e.value = ''));
    await refused(page, request, 'SPI', 'Invalid MAX7219Matrix Config');
  });
});

test('what a new row of each type starts with', async ({ page }) => {
  await open(page);
  const max = await page.evaluate(() => String((window as any).FPPD_MAX_CHANNELS));

  async function fresh(category: string, type: string) {
    await tab(page, category).click();
    await add(page, category).click();
    await page.locator(`#outputType-${category}`).selectOption(type);
    const r = rows(page, category).last();
    await expect(r.locator('input.type')).toHaveValue(type);
    await expect(r.locator('input.start')).toHaveValue('1');
    await expect(r.locator('input.act')).not.toBeChecked();
    return r;
  }

  const dmx = await fresh('DMXSerial', 'DMX-Pro');
  await expect(dmx.locator('input.count')).toHaveValue('512');
  await expect(dmx.locator('input.count')).toHaveAttribute('max', '512');
  const pixelnet = await fresh('DMXSerial', 'Pixelnet-Lynx');
  await expect(pixelnet.locator('input.count')).toHaveValue('4096');
  await expect(pixelnet.locator('input.count')).toBeDisabled();
  const renard = await fresh('DMXSerial', 'Renard');
  await expect(renard.locator('input.count')).toHaveValue('286');
  await expect(renard.locator('select.renardspeed')).toHaveValue('57600');
  await expect(renard.locator('select.renardparm')).toHaveValue('8N1');
  const lor = await fresh('DMXSerial', 'LOR');
  await expect(lor.locator('input.count')).toHaveValue('16');
  await expect(lor.locator('select.speed')).toHaveValue('19200');
  await expect(lor.locator('input.firstControllerId')).toHaveValue('1');
  const serial = await fresh('DMXSerial', 'GenericSerial');
  await expect(serial.locator('input.count')).toHaveValue('1');
  await expect(serial.locator('select.speed')).toHaveValue('9600');
  await expect(serial.locator('input.serialheader')).toHaveValue('');

  const relay = await fresh('ControlSignal', 'USBRelay');
  await expect(relay.locator('input.count')).toHaveValue('2');
  await expect(relay.locator('input.count')).toBeDisabled();
  await expect(relay.locator('select.subType')).toHaveValue('ICStation');
  await expect(relay.locator('select.relayCount')).toHaveValue('2');

  const display = await fresh('VirtualDisplay', 'HTTPVirtualDisplay');
  await expect(display.locator('input.count')).toHaveValue(max);
  await expect(display.locator('input.count')).toBeDisabled();
  await expect(display.locator('input.start')).toBeDisabled();
  await expect(display.locator('input.width')).toHaveValue('1280');
  await expect(display.locator('input.height')).toHaveValue('1024');
  await expect(display.locator('select.pixelSize')).toHaveValue('2');
  await expect(display.locator('input.updateInterval')).toHaveValue('25');
});

test('a DMX count the file has above a universe, or as none, is shown as a full universe', async ({ page, request }) => {
  const w = await request.post('/api/channel/output/co-other', {
    data: {
      channelOutputs: [
        { type: 'DMX-Pro', enabled: 0, startChannel: 1, channelCount: 600, device: PORT, description: 'over' },
        { type: 'DMX-Open', enabled: 0, startChannel: 700, channelCount: 0, device: PORT, description: 'none' },
        { type: 'DMX-Open', enabled: 0, startChannel: 1400, device: PORT, description: 'missing' },
      ],
    },
  });
  expect(w.ok()).toBe(true);
  await page.goto('/channeloutputs.php?t=' + Date.now());
  await expect(rows(page, 'DMXSerial')).toHaveCount(3, { timeout: 15_000 });
  await tab(page, 'DMXSerial').click();
  await expect(rows(page, 'DMXSerial').locator('input.count')).toHaveCount(3);
  expect(await rows(page, 'DMXSerial').locator('input.count').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual([
    '512',
    '512',
    '1',
  ]);
});

test('a save the player does not take is reported, and the rows stay as typed', async ({ page, request }) => {
  await open(page);
  await tab(page, 'DMXSerial').click();
  await page.route('**/api/channel/output/co-other', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'no' }) : route.fallback()
  );
  const renard = row(page, 'DMXSerial', 'Renard');
  await renard.locator('input.count').fill('99');
  await save(page, 'DMXSerial').click();
  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Save Failed');
  await expect(dialog.locator('.modal-title')).toHaveText('Save Channel Outputs');
  await expect(renard.locator('input.count')).toHaveValue('99');
  expect(byType(await stored(request))).toEqual(byType(saved));
});

test.describe('the Status menu', () => {
  const display = (type: string, enabled: number) => ({ type, enabled, startChannel: 1, channelCount: 8388608, width: 640, height: 480, pixelSize: 2 });
  const links = (page: Page) =>
    page
      .locator('#navbarDropdownMenuLinkStatus + .dropdown-menu a')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')).filter((h) => /testing|virtualdisplay/.test(h ?? '')));

  // What the page is told is saved: fppd is not asked to run a display.
  async function openWith(page: Page, outputs: object[]) {
    await page.route(
      (url) => url.pathname.endsWith('/api/channel/output/co-other'),
      (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { channelOutputs: outputs } }) : route.fallback())
    );
    await page.goto('/channeloutputs.php?t=' + Date.now());
    await expect(rows(page, 'VirtualDisplay')).toHaveCount(outputs.length, { timeout: 15_000 });
  }

  test('gets a 2D and a 3D Virtual Display link, after Display Testing, for the displays that are enabled', async ({ page }) => {
    await openWith(page, [display('HTTPVirtualDisplay', 1), display('HTTPVirtualDisplay3D', 1)]);
    await expect.poll(() => links(page)).toEqual(['testing.php', 'virtualdisplaywrapper.php', 'virtualdisplaywrapper3d.php']);
  });

  test('gets only the 3D link when that is the only display enabled, and none for a disabled display', async ({ page }) => {
    await openWith(page, [display('HTTPVirtualDisplay', 0), display('HTTPVirtualDisplay3D', 1)]);
    await expect.poll(() => links(page)).toEqual(['testing.php', 'virtualdisplaywrapper3d.php']);
  });
});
