import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The E1.31 / ArtNet / DDP tab of Channel Outputs (co-universes.php): what a
// row offers for each output type, the type a new row starts as, and an
// ArtNet universe 0 kept as 0.  Saving writes co-universes.json, which fppd
// reloads; what fppd then puts on the wire is the receiving end.

test.skip(!container, 'changes the player\'s output config');

const universe = (i: number, extra: Record<string, unknown> = {}) => ({
  active: 1, description: `fpp-tests ${i}`, id: i, startChannel: 1, universeCount: 1, channelCount: 510,
  type: 1, address: '10.0.0.5', priority: 0, monitor: 0, deDuplicate: 0, ...extra,
});

function config(universes: object[]) {
  return { channelOutputs: [{ type: 'universes', enabled: 1, interface: 'eth0', threaded: 1,
                              startChannel: 1, channelCount: -1, universes }] };
}

async function put(request: APIRequestContext, body: object) {
  const r = await request.post('/api/channel/output/universeOutputs', { data: body });
  expect(r.ok(), await r.text()).toBe(true);
}

async function stored(request: APIRequestContext) {
  return (await (await request.get('/api/channel/output/universeOutputs')).json()).channelOutputs[0];
}

let before: string | null = null;
let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/channel/output/universeOutputs');
  before = r.ok() ? await r.text() : null;
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  // Advanced, so that the priority column is shown at all.
  await request.put('/api/settings/uiLevel', { data: '1' });
});
test.afterEach(async ({ request }) => {
  await request.post('/api/command', { data: { command: 'Test Stop', args: [] } });
  await request.post('/api/channel/output/universeOutputs', {
    data: Buffer.from(before && !before.includes('File not found') ? before : '{"channelOutputs": []}'),
  });
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function openUniverses(page: Page, rows: number) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await page.locator('#tab-e131-tab').click();
  await expect(page.locator('#tblUniversesBody > tr')).toHaveCount(rows, { timeout: 15_000 });
}

const row = (page: Page, i: number) => page.locator('#tblUniversesBody > tr').nth(i);
const save = (page: Page) => page.locator('#frmUniverses input[value="Save"]:not(.Zebra_Pin_Clone *)').click();

// Listens on the player's loopback 6454 for up to 6 s and prints the port
// addresses of the ArtDMX packets heard (stopping at the first).
const LISTEN_ARTDMX = `
import socket, struct, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 6454))
s.settimeout(1)
seen = set()
end = time.time() + 6
while time.time() < end and not seen:
    try:
        p = s.recv(2048)
    except socket.timeout:
        continue
    if p[:8] == b"Art-Net\\0" and struct.unpack("<H", p[8:10])[0] == 0x5000:
        seen.add(struct.unpack("<H", p[14:16])[0])
print(sorted(seen))
`;

test('a row shows the fields its output type uses and hides the rest', async ({ page, request }) => {
  // Regression: 25035983d.  The fields a type doesn't use (universe and
  // universe count for DDP, the address and ping button for multicast and
  // broadcast, priority for anything but E1.31) were only disabled, left
  // on show as greyed-out boxes.
  await put(request, config([universe(1)]));
  await openUniverses(page, 1);
  const r = row(page, 0);
  const field = (cls: string) => r.locator(`input.${cls}`);
  const type = r.locator('select.universeType');

  await expect(field('txtUniverse')).toBeVisible();
  await expect(field('txtIP')).toBeVisible();
  await expect(field('txtPriority')).toBeVisible();

  await type.selectOption('4'); // DDP
  await expect(field('txtUniverse')).toBeHidden();
  await expect(field('numUniverseCount')).toBeHidden();
  await expect(field('txtPriority')).toBeHidden();
  await expect(field('txtIP')).toBeVisible();
  await expect(field('txtMonitor')).toBeVisible();

  await type.selectOption('0'); // E1.31 multicast
  await expect(field('txtUniverse')).toBeVisible();
  await expect(field('numUniverseCount')).toBeVisible();
  await expect(field('txtPriority')).toBeVisible();
  await expect(field('txtIP')).toBeHidden();
  await expect(field('pingButton')).toBeHidden();
  await expect(field('txtMonitor')).toBeHidden();

  await type.selectOption('2'); // ArtNet broadcast
  await expect(field('txtPriority')).toBeHidden();
  await expect(field('txtIP')).toBeHidden();
});

test('a new universe row starts as E1.31 unicast', async ({ page, request }) => {
  // Regression: 1d6eb1474.  With no universes yet, setting a count made
  // rows of E1.31 multicast, which most controllers are not set up for.
  await put(request, { channelOutputs: [] });
  await openUniverses(page, 0);
  await page.locator('#txtUniverseCount').fill('2');
  await page.locator('#btnUniverseCount').click();
  await expect(page.locator('#tblUniversesBody > tr')).toHaveCount(2);
  for (const i of [0, 1]) await expect(row(page, i).locator('select.universeType')).toHaveValue('1');
  for (const i of [0, 1]) {
    await row(page, i).locator('input.txtIP').fill('10.0.0.7');
    await row(page, i).locator('input.txtIP').dispatchEvent('change');
  }
  await save(page);
  await expect.poll(async () => ((await stored(request))?.universes ?? []).map((u: any) => u.type), { timeout: 15_000 })
    .toEqual([1, 1]);
});

test('an ArtNet universe 0 loads, saves and goes out as universe 0', async ({ page, request }) => {
  // Regression: 10a12990d.  Universe 0 is a valid ArtNet port address, but
  // the page raised any universe under 1 to 1 as it laid out the row, so
  // opening the tab and saving moved the output to universe 1.
  // Type 9: ArtNet unicast from an ephemeral port, so a listener can hold
  // 6454 on the player's loopback.  fppd drops outputs to its own addresses
  // unless DisableFakeNetworkBridges is on.
  const bridges = String((await (await request.get('/api/settings/DisableFakeNetworkBridges')).json()).value ?? '0');
  await request.put('/api/settings/DisableFakeNetworkBridges', { data: '1' });
  try {
    await put(request, config([universe(0, { type: 9, address: '127.0.0.1', channelCount: 16 })]));
    await openUniverses(page, 1);
    await expect(row(page, 0).locator('input.txtUniverse')).toHaveValue('0');
    await row(page, 0).locator('input.txtDesc').fill('fpp-tests artnet 0');
    await save(page);
    await expect.poll(async () => (await stored(request)).universes[0].description, { timeout: 15_000 }).toBe('fpp-tests artnet 0');
    expect((await stored(request)).universes[0]).toMatchObject({ id: 0, type: 9 });

    // fppd's side: with a test pattern running, the ArtDMX packets it sends to
    // that address carry port address 0.
    const t = await request.post('/api/command', { data: { command: 'Test Start', args: ['1000', 'RGB Cycle', '1-16', 'R-G-B'] } });
    expect(t.ok()).toBe(true);
    const heard = inPlayer('python3', '-c', LISTEN_ARTDMX).trim();
    expect(heard, 'the ArtDMX port addresses fppd sent').toBe('[0]');
  } finally {
    await request.put('/api/settings/DisableFakeNetworkBridges', { data: bridges || '0' });
  }
});

test('rows opened from a saved config already hide the fields their type does not use', async ({ page, request }) => {
  // Regression: 1f6a4970a.  The fields were hidden when the type was
  // changed, not when a saved row was drawn, so a saved DDP or multicast row
  // came up showing every field.
  await put(request, config([universe(1, { type: 4 }), universe(2, { type: 0, address: '' })]));
  await openUniverses(page, 2);
  const field = (i: number, cls: string) => row(page, i).locator(`input.${cls}`);
  await expect(field(0, 'txtUniverse')).toBeHidden();
  await expect(field(0, 'txtPriority')).toBeHidden();
  await expect(field(0, 'txtIP')).toBeVisible();
  await expect(field(1, 'txtIP')).toBeHidden();
  await expect(field(1, 'txtMonitor')).toBeHidden();
});
