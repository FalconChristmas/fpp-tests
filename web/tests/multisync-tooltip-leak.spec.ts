import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// With auto refresh on, the MultiSync page re-renders its systems table on
// every status poll (~2 s).  Bootstrap keeps every Tooltip instance in a
// global Map keyed by its element until dispose(), so an instance left on a
// replaced row keeps that row -- and the whole detached tbody -- alive.  The
// test wraps bootstrap.Tooltip before the page loads to count the instances
// still live.  The list and the polls are answered by the test.

const base = {
  fppMode: 2, fppModeString: 'player', typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
  version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000, channelRanges: '',
  multiSyncCapable: 1, multisync: false, lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
};

const SYSTEMS = {
  systems: [
    { ...base, address: '192.168.0.13', hostname: 'FPPTESTLOCAL', local: 1, uuid: 'M1-fpptests-local' },
    { ...base, address: '192.168.0.21', hostname: 'FPPTESTREMOTE1', local: 0, uuid: 'M1-fpptests-remote1' },
    { ...base, address: '192.168.0.22', hostname: 'FPPTESTREMOTE2', local: 0, uuid: 'M1-fpptests-remote2' },
  ],
};

// Each row's Utilization cell gets an uptime <span title="since ...">, which
// SetupToolTips() turns into a tooltip on every render.
function status() {
  return {
    status_name: 'idle', mode_name: 'player', warnings: [],
    advancedView: { Utilization: { CPU: 5, Memory: 20, Uptime: 3_600_000 } },
  };
}

async function liveTooltips(page: Page) {
  return page.evaluate(() => {
    const live: Set<any> = (window as any).__liveTooltips;
    let detached = 0;
    live.forEach((t) => { if (!t._element || !t._element.isConnected) detached++; });
    return { total: live.size, detached };
  });
}

test('status polls do not leave tooltip instances on replaced rows', async ({ page, request }) => {
  // Regression: 589fe225d.  Each poll's SetupToolTips() built a new Tooltip
  // on every tooltip element on the page and disposed none: the rows a render
  // replaced stayed referenced, and the tab's memory grew until it crashed.
  test.setTimeout(90_000);

  await page.addInitScript(() => {
    const live = new Set<any>();
    (window as any).__liveTooltips = live;
    let bs: any;
    Object.defineProperty(window, 'bootstrap', {
      configurable: true,
      get: () => bs,
      set: (v: any) => {
        const Base = v.Tooltip;
        v.Tooltip = class extends Base {
          constructor(...args: any[]) { super(...args); live.add(this); }
          dispose() { live.delete(this); super.dispose(); }
        };
        bs = v;
      },
    });
  });

  let polls = 0;
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => {
    const url = new URL(route.request().url());
    const json: Record<string, unknown> = {};
    if (url.searchParams.get('type') === 'FPP') {
      polls++;
      for (const ip of url.searchParams.getAll('ip[]')) json[ip] = status();
    }
    return route.fulfill({ json });
  });
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));

  await request.put('/api/settings/MultiSyncRefreshStatus', { data: '1' });
  try {
    await page.goto('/multisync.php');
    await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(3, { timeout: 15_000 });

    // A poll is only scheduled once the previous one has rendered, so when
    // poll n+1 is requested, render n is done.
    await expect.poll(() => polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    const early = await liveTooltips(page);
    await expect.poll(() => polls, { timeout: 30_000 }).toBeGreaterThanOrEqual(9);
    const late = await liveTooltips(page);

    expect(late.total, 'uptime tooltips were created').toBeGreaterThan(0);
    expect(late.detached, `instances left on removed elements: ${JSON.stringify({ early, late })}`).toBe(0);
    expect(late.total, `live instances grew across polls: ${JSON.stringify({ early, late })}`).toBeLessThanOrEqual(early.total);
  } finally {
    await request.put('/api/settings/MultiSyncRefreshStatus', { data: '0' });
  }
});
