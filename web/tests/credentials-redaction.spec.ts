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
//
// The same secrets were still served by other routes: the file API maps the
// config directory and refused no dotfiles, so it read, replaced and deleted
// .htpasswd, and /api/configfile/interface.<if> and /api/file/config/
// interface.<if> returned the saved WiFi key.  Regression: ea6f1c689
// ("fix(security): keep .htpasswd and WiFi keys out of the generic file
// APIs").  JSON settings backups keep their passwords on purpose.

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

const HTPASSWD = '/home/fpp/media/config/.htpasswd';

test.describe('.htpasswd', () => {
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');
  test.beforeEach(() => inPlayer('sh', '-c', `printf 'fpp-tests:x\\n' > ${HTPASSWD}`));
  test.afterEach(() => inPlayer('rm', '-f', HTPASSWD));

  test('the config-file API refuses .htpasswd', async ({ request }) => {
    const r = await request.get('/api/configfile/.htpasswd');
    expect(r.status()).toBe(403);
    expect(await r.text()).not.toContain('fpp-tests:x');
    const list = await (await request.get('/api/configfile')).json();
    // The control: the listing lists files.
    expect(list.ConfigFiles).toContain('commandPresets.json');
    expect(list.ConfigFiles).not.toContain('.htpasswd');
  });

  test('the file API neither serves, replaces nor deletes .htpasswd', async ({ request }) => {
    const r = await request.get('/api/file/config/.htpasswd');
    expect(await r.text(), 'the file API served .htpasswd').not.toContain('fpp-tests:x');
    expect(r.status()).toBe(403);

    expect((await request.post('/api/file/config/.htpasswd', { data: 'fpp-tests:y' })).ok()).toBe(false);
    expect((await request.delete('/api/file/config/.htpasswd')).ok()).toBe(false);
    expect(inPlayer('cat', HTPASSWD)).toBe('fpp-tests:x\n');

    const listed = await (await request.get('/api/files/config?nameOnly=1&maxdepth=1')).json();
    // The control: the listing lists files.
    expect(listed).toContain('commandPresets.json');
    expect(listed).not.toContain('.htpasswd');
  });
});

test.describe('WiFi keys', () => {
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

  test('the config-file and file APIs do not serve a saved key', async ({ request }) => {
    const save = await request.post(`/api/network/interface/${IFACE}`, {
      data: { INTERFACE: IFACE, PROTO: 'dhcp', SSID: 's', PSK: 'fpp-tests-psk' },
    });
    expect((await save.json()).status).toBe('OK');
    try {
      // The control: the key is in the file these routes would serve.
      expect(inPlayer('cat', `/home/fpp/media/config/interface.${IFACE}`)).toContain('fpp-tests-psk');
      for (const url of [`/api/configfile/interface.${IFACE}`, `/api/file/config/interface.${IFACE}`]) {
        const r = await request.get(url);
        expect(await r.text(), `${url} served the key`).not.toContain('fpp-tests-psk');
        expect(r.status(), url).toBe(403);
      }
      const list = await (await request.get('/api/configfile')).json();
      expect(list.ConfigFiles).not.toContain(`interface.${IFACE}`);
    } finally {
      await request.delete(`/api/network/interface/${IFACE}`);
    }
  });

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
