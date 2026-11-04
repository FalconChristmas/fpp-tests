import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// /api/network/presisentNames (the misspelt route is the API's): POST pins each
// interface's name to its MAC with a systemd .link file, DELETE takes them away
// and goes back to masking the default naming.  The files are in the container.

test.skip(!container, "changes /etc/systemd/network in the run-web.sh container");

const NET = '/etc/systemd/network';
const links = () => inPlayer('sh', '-c', `ls ${NET} 2>/dev/null | grep -- '-fpp-' || true`).trim().split('\n').filter(Boolean);

test.afterEach(() => {
  inPlayer('sh', '-c', `rm -f ${NET}/5?-fpp-*.link ${NET}/99-default.link ${NET}/73-usb-net-by-mac.link`);
});

test('a POST pins eth0 to its MAC and a DELETE removes the pin', async ({ request }) => {
  // Feature: c54a627f7.
  inPlayer('mkdir', '-p', NET);
  const mac = inPlayer('cat', '/sys/class/net/eth0/address').trim();
  const created = await request.post('/api/network/presisentNames');
  expect(created.ok(), await created.text()).toBe(true);
  expect((await created.json()).status).toBe('OK');
  const file = links().find((f) => f.endsWith('-fpp-eth0.link'));
  expect(file, `the link files: ${links()}`).toBeTruthy();
  const link = inPlayer('cat', `${NET}/${file}`);
  expect(link).toMatch(new RegExp(`^MACAddress=${mac}$`, 'm'));
  expect(link).toContain('Name=eth0');

  const removed = await request.delete('/api/network/presisentNames');
  expect(removed.ok(), await removed.text()).toBe(true);
  expect(links()).toEqual([]);
  expect(inPlayer('readlink', `${NET}/99-default.link`).trim()).toBe('/dev/null');
});
