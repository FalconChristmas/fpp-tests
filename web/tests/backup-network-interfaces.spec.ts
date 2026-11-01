import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// A settings backup carried only the eth0 and wlan0 interface configs, so a
// player with a USB ethernet or second WiFi adapter lost its other
// interfaces' settings.  Feature: 3b20ec1ff ("Updated JSON Backup to gather
// extra JSON config files & network interfaces") backs up every
// config/interface.<name> it finds beside those two.

const CONFIG = '/home/fpp/media/config';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a settings backup carries the config of an interface besides eth0 and wlan0', async ({ request }) => {
  inPlayer('mkdir', '-p', `${CONFIG}/backups`);
  inPlayer('sh', '-c', `printf 'INTERFACE=fpptest0\\nPROTO=dhcp\\n' > ${CONFIG}/interface.fpptest0`);
  let name = '';
  try {
    const made = await (await request.post('/api/backups/configuration', { data: 'fpp-tests-extra-interface' })).json();
    expect(made.success, JSON.stringify(made)).toBe(true);
    name = made.backup_file_path.split('/').pop();
    const r = await request.get(`/api/backups/configuration/JsonBackups/${name}`);
    expect(r.ok()).toBe(true);
    const network = JSON.parse(await r.text()).network ?? {};
    expect(Object.keys(network), JSON.stringify(network)).toContain('interface.fpptest0');
    expect(JSON.stringify(network['interface.fpptest0'])).toContain('INTERFACE=fpptest0');
  } finally {
    inPlayer('rm', '-f', `${CONFIG}/interface.fpptest0`);
    if (name) await request.delete(`/api/backups/configuration/JsonBackups/${name}`);
  }
});
