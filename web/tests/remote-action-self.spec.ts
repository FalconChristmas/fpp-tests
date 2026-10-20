import { test, expect } from './fixtures';

// /api/remoteAction proxies a few requests to another player by IP, never to
// this one: Apache counts a request from the player itself as local, so a
// loopback target reached its local-only pages.  Fixed in fpp 4d5c2a63e
// ("fix(api): remoteAction only reaches other players, and follows only
// http(s) redirects"); before it 127.0.0.1 passed FILTER_VALIDATE_IP and the
// player's own answer came back.  (Not action=reboot: before the fix that
// rebooted the player under test.)

for (const ip of ['127.0.0.1', '127.8.8.8', '0.0.0.0']) {
  test(`remoteAction refuses ${ip} as its target`, async ({ request }) => {
    const r = await request.get(`/api/remoteAction?ip=${ip}&action=listUpgrades`);
    const body = await r.text();
    expect(r.status(), body.slice(0, 300)).toBe(400);
    expect(body).toContain('Invalid IP address');
  });
}
