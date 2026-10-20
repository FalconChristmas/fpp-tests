import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// /api answered any origin, so on a player without a UI password any web page
// a user visited could read what it returned: GET /api/settings/<name> gave
// password settings in clear, the network interface routes gave every saved
// WiFi key, and the config-file API served, overwrote and deleted dotfiles
// such as .htpasswd.  Fixed in fpp 4cdd77ac8 ("fix(security): stop returning
// stored credentials from the API"): password settings come back without a
// value, interfaces report PSKSet instead of the key (and a save without a key
// keeps the saved one), and the config-file API refuses dotfiles.

const IFACE = 'wlan9'; // no such device in the test player: only its file is written

async function getSetting(request: APIRequestContext, name: string) {
  return (await request.get(`/api/settings/${name}`)).json();
}

test('a password setting is stored but not returned', async ({ request }) => {
  try {
    const r = await request.put('/api/settings/MQTTPassword', { data: 'fpp-tests-pw' });
    expect(r.ok(), await r.text()).toBe(true);
    const got = await getSetting(request, 'MQTTPassword');
    // The control: the setting's declaration came back, just not its value.
    expect(got.type).toBe('password');
    expect(got.value, 'the stored password was returned').toBeUndefined();
  } finally {
    await request.put('/api/settings/MQTTPassword', { data: '' });
  }
});

test('the config-file API refuses .htpasswd', async ({ request }) => {
  try {
    // Put one there through the file API, which still writes it.
    const up = await request.post('/api/file/config/.htpasswd', { data: 'fpp-tests:x' });
    expect(up.ok(), await up.text()).toBe(true);

    const r = await request.get('/api/configfile/.htpasswd');
    expect(r.status()).toBe(403);
    expect(await r.text()).not.toContain('fpp-tests:x');
    const list = await (await request.get('/api/configfile')).json();
    // The control: the listing lists files.
    expect(list.ConfigFiles).toContain('commandPresets.json');
    expect(list.ConfigFiles).not.toContain('.htpasswd');
  } finally {
    await request.delete('/api/file/config/.htpasswd');
  }
});

test.describe('WiFi keys', () => {
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

  test('an interface reports that a key is saved, not the key, and keeps it', async ({ request }) => {
    const save = (data: object) =>
      request.post(`/api/network/interface/${IFACE}`, { data: { INTERFACE: IFACE, PROTO: 'dhcp', SSID: 's', ...data } });
    try {
      expect((await (await save({ PSK: 'fpp-tests-psk' })).json()).status).toBe('OK');

      const got = await (await request.get(`/api/network/interface/${IFACE}`)).json();
      expect(got.SSID).toBe('s');
      expect(got.PSK, 'the saved key was returned').toBeUndefined();
      expect(got.PSKSet).toBe(true);

      // Saving without a key, as the page does when it was not touched.
      expect((await (await save({})).json()).status).toBe('OK');
      expect(inPlayer('cat', `/home/fpp/media/config/interface.${IFACE}`)).toContain('PSK="fpp-tests-psk"');
    } finally {
      await request.delete(`/api/network/interface/${IFACE}`);
    }
  });
});
