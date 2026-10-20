import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Proxy hosts and descriptions, output processor descriptions and other names
// were concatenated into single-quoted value='...' attributes as they were.
// A description with an apostrophe ("Bob's tree") was cut short at it, and
// saved that way on the next save; one holding ' onfocus='...' added an
// attribute that ran script.  Fixed in fpp 6900cc21e ("fix(security): escape
// descriptions and names put into the page").

const VALUE = "Bob's tree' autofocus onfocus='window.__fppTestsDescription=1";

async function assertRoundTrip(page: Page, selector: string) {
  const input = page.locator(selector);
  await expect(input).toHaveValue(VALUE, { timeout: 15_000 });
  await input.focus();
  expect(await page.evaluate(() => (window as any).__fppTestsDescription)).toBeUndefined();
}

test('a proxy description with quotes round-trips through its input', async ({ page, request }) => {
  const before = await (await request.get('/api/proxies')).json();
  try {
    const r = await request.post('/api/proxies', { data: [{ host: '192.0.2.10', description: VALUE }] });
    expect(r.ok(), await r.text()).toBe(true);
    await page.goto('/proxies.php');
    await assertRoundTrip(page, '#descRow0');
  } finally {
    const kept = (before as any[]).filter((p) => !p.dhcp);
    if (kept.length) {
      await request.post('/api/proxies', { data: kept });
    } else {
      await request.delete('/api/proxies');
    }
  }
});

test('an output processor description with quotes round-trips through its input', async ({ page, request }) => {
  const before = await (await request.get('/api/channel/output/processors')).text();
  try {
    const r = await request.post('/api/channel/output/processors', {
      data: {
        status: 'OK',
        outputProcessors: [{ type: 'Remap', active: 0, description: VALUE, source: 1, destination: 2, count: 1, loops: 1, reverse: 0 }],
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
    await page.goto('/outputprocessors.php');
    await assertRoundTrip(page, '#outputProcessors tbody tr#row0 input.description');
  } finally {
    await request.post('/api/channel/output/processors', { data: Buffer.from(before) });
  }
});
