import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings } from './privacy-helpers';
import { putFile } from './settings-file';

// Feature: f55aa5f85 ("Switch NTP daemon from ntpsec to chrony", #2736).
// The "Override default NTP Server" setting rewrites the source line of
// chrony's config, /etc/chrony/chrony.conf, and leaves FPP's server-mode
// policy in it (allow all, local stratum 10) so the player keeps serving
// time to the controllers pointed at it; then chrony is restarted.  Before,
// it edited ntpsec's ntp.conf and restarted "ntp".  The config is the one
// the tree's own SD/FPP_Install.sh writes (configure_ntp).  The player has no
// chrony and no systemd: systemctl is a stand-in that logs its calls, and
// the config is checked as the text chronyd would read, not by a chronyd.

test.skip(!container, 'edits /etc/chrony inside the run-web.sh container');

const CONF = '/etc/chrony/chrony.conf';
const SYSTEMCTL = '/usr/local/bin/systemctl';
const MARK = 'fpp-tests-ntp-systemctl';

test.beforeEach(() => {
  const has = inPlayer('sh', '-c', `test -e ${CONF} && echo y; test -e ${SYSTEMCTL} && ! grep -q ${MARK} ${SYSTEMCTL} && echo real; true`).trim();
  test.skip(has !== '', 'the player has its own chrony config or systemctl');
  inPlayer('sh', '-c', `mkdir -p /etc/chrony && sed -n "/^    cat > \\/etc\\/chrony\\/chrony.conf <<'EOF'$/,/^EOF$/p" ` +
    `/opt/fpp/SD/FPP_Install.sh | sed '1d;$d' > ${CONF}`);
  putFile(SYSTEMCTL, `#!/bin/sh\n# ${MARK}\necho "$*" >> /tmp/fpp-tests-ntp-systemctl.log\nexit 0\n`);
  inPlayer('chmod', '755', SYSTEMCTL);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `grep -q ${MARK} ${SYSTEMCTL} 2>/dev/null && rm -f ${SYSTEMCTL}; rm -rf /etc/chrony /tmp/fpp-tests-ntp-systemctl.log; true`);
});

const lines = () => inPlayer('cat', CONF).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test("setting an NTP server points chrony at it and keeps the player serving time", async ({ request }) => {
  // The control: the tree's config, with its default pool.
  expect(lines()).toContain('pool falconplayer.pool.ntp.org iburst minpoll 8 maxpoll 12');
  await keepingSettings(async () => {
    const r = await request.put('/api/settings/ntpServer', { data: '192.0.2.50' });
    expect(r.ok(), await r.text()).toBe(true);
    const now = lines();
    expect(now).toContain('server 192.0.2.50 iburst');
    expect(now.filter((l) => l.startsWith('pool ')), 'the default pool was left in').toEqual([]);
    expect(now).toContain('allow all');
    expect(now).toContain('local stratum 10');
    expect(inPlayer('cat', '/tmp/fpp-tests-ntp-systemctl.log')).toContain('restart chrony');

    // Back to the default: the pool, and no override server.
    await request.put('/api/settings/ntpServer', { data: '' });
    const back = lines();
    expect(back).toContain('pool falconplayer.pool.ntp.org iburst minpoll 8 maxpoll 12');
    expect(back.filter((l) => l.startsWith('server 192.0.2.50'))).toEqual([]);
  });
});
