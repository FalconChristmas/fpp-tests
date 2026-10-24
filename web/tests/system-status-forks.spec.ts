import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// GET /api/system/status reports whether systemd's restart limit is holding
// fppd back.  A stand-in systemctl in /usr/local/bin (first on the PATH the
// web server's shell commands get) logs every call and hands it on to the
// real one.

test.skip(!container, 'puts a stand-in systemctl inside the run-web.sh container');

const STUB = '/usr/local/bin/systemctl';
const LOG = '/tmp/fpp-tests-systemctl.log';
const HOSTAPD = '/etc/hostapd';

function calls(): string[] {
  return inPlayer('sh', '-c', `cat ${LOG} 2>/dev/null || true`).split('\n').filter((l) => l.trim());
}

test('a status poll with fppd up runs no systemctl', async ({ request }) => {
  // Regression: 80746b5ed.  Every api/system/status forked `which systemctl`
  // and two `systemctl show fppd` to see whether a restart limit held fppd
  // back -- most of the request's time on a BeagleBone -- though an fppd
  // answering on its API port can't be held back by anything.
  const hadHostapd = inPlayer('sh', '-c', `test -e ${HOSTAPD} && echo y || echo n`).trim() === 'y';
  inPlayer('sh', '-c', `printf '#!/bin/sh\\necho "$*" >> ${LOG}\\nexec /usr/bin/systemctl "$@"\\n' > ${STUB} && chmod 755 ${STUB} && : > ${LOG} && chmod 666 ${LOG}`);
  try {
    // The control: a web request that does ask systemctl (whether FPP's
    // hotspot is up, which needs a hostapd config to get that far) reaches
    // the stand-in.
    const iface = inPlayer('sh', '-c', "ip -o route show default | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p' | head -1").trim();
    if (!hadHostapd) inPlayer('sh', '-c', `mkdir -p ${HOSTAPD} && echo 'interface=${iface}' > ${HOSTAPD}/hostapd.conf`);
    await request.get(`/api/network/wifi/status/${iface}`, { timeout: 30_000 });
    expect(calls().join('\n'), 'the stand-in systemctl is not the one the web server runs').toContain('is-active hostapd');

    inPlayer('sh', '-c', `: > ${LOG}`);
    for (const path of ['/api/system/status', '/api/system/status?simple&nonetwork']) {
      const r = await request.get(path, { timeout: 30_000 });
      expect(r.ok()).toBe(true);
      const s = await r.json();
      expect(s.fppdRestartBlocked?.blocked ?? false, JSON.stringify(s.fppdRestartBlocked)).toBe(false);
    }
    expect(calls()).toEqual([]);
  } finally {
    inPlayer('rm', '-f', STUB, LOG);
    if (!hadHostapd) inPlayer('rm', '-rf', HOSTAPD);
  }
});
