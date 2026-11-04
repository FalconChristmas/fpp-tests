import { test, expect } from './fixtures';
import { container, playerAddress } from './container';

// GET /api/system/status: what every page's header and the MultiSync page
// poll -- fppd's status with the player's own additions (its interfaces,
// warnings, the advanced view) -- for this player, or with ip[] for others.

test('the system status is fppd\'s status with this player\'s interfaces', async ({ request }) => {
  // Feature: 08c8dd19d ("/api/system/status -- #945"): the status the
  // fppjson.php getFPPstatus command gave, as an API endpoint, with the
  // interfaces (ip --json address, wifi merged in) added.
  const r = await request.get('/api/system/status');
  expect(r.status()).toBe(200);
  const s = await r.json();
  const fppd = await (await request.get('/api/fppd/status')).json();
  expect(s.fppd).toBe('running');
  expect(s.mode_name).toBe(fppd.mode_name);
  expect(typeof s.status_name).toBe('string');
  expect(Array.isArray(s.interfaces), JSON.stringify(s).slice(0, 300)).toBe(true);
  if (container) {
    const { ip } = playerAddress();
    const mine = s.interfaces.find((i: any) => (i.addr_info ?? []).some((a: any) => a.local === ip));
    expect(mine, `an interface with ${ip}`).toBeTruthy();
  }
  // With advancedView, the version the player runs.
  const adv = await (await request.get('/api/system/status?advancedView=true')).json();
  expect(typeof adv.advancedView?.Version).toBe('string');
});
