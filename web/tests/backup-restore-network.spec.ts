import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Restoring a configuration backup's network section, without "Keep existing
// network settings", took each key of the section as a file name under
// config/ and wrote its lines there, so a crafted backup wrote whatever
// config file it named.  Fixed in fpp 2144bf8bf ("fix(security): restore only
// interface configs from a backup's network section"): a key must be an
// interface config (interface.<ifname>).
//
// Only the Backup page's own form reaches this: the API and setup wizard
// restores always keep the network settings.

const CONFIG = '/home/fpp/media/config';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a backup restore writes only interface configs from its network section', async ({ request }) => {
  const backup = {
    fpp_backup_version: '8.0',
    network: {
      'interface.fpptest0': [['INTERFACE=fpptest0', 'PROTO=dhcp']],
      'fpp-tests-injected': [['X=1']],
    },
  };
  try {
    const r = await request.post('/backup.php', {
      multipart: {
        btnRestoreConfig: '1',
        restorearea: 'network',
        conffile: { name: 'fpp-tests.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) },
      },
    });
    expect(r.ok()).toBe(true);
    // The control: the interface in the same section was restored.
    expect(inPlayer('sh', '-c', `cat ${CONFIG}/interface.fpptest0 2>/dev/null || true`)).toContain('INTERFACE=fpptest0');
    expect(inPlayer('sh', '-c', `test -e ${CONFIG}/fpp-tests-injected && echo written || echo absent`).trim(),
      'the restore wrote a file the network section named').toBe('absent');
  } finally {
    inPlayer('rm', '-f', `${CONFIG}/interface.fpptest0`, `${CONFIG}/fpp-tests-injected`);
  }
});
