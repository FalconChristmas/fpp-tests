import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Turning a service setting off and straight back on leaves the service on.
// Fixed in fpp 8aaa65d20 ("feat(services): add apply_service_setting script
// for background service management", issue #3107).  Before it each save
// checked "systemctl is-enabled" and started enable/disable in the
// background: the "on" saw the service still enabled (the slow
// "disable --now" had not finished) and did nothing, then the disable landed,
// leaving the setting on and the service off.
//
// Also 673cea4a6: ApplyServiceSetting() lacked `global $settings`, so the path of
// the apply script came out as "/scripts/apply_service_setting" and no save
// ever reached systemctl (red with the line removed: the stand-in is never asked).
//
// systemctl in the player is replaced for the test by a stand-in that keeps
// unit state in files and takes 2 s over "disable --now", as the real one
// can.  (scripts/common puts /usr/bin first on PATH, so it has to be that one.)

test.skip(!container, 'replaces systemctl inside the run-web.sh container');

const STATE = '/tmp/fpp-tests-systemd';
const STUB = `#!/bin/sh
S=${STATE}
echo "$*" >> $S/calls
now=; verb=; unit=
for a in "$@"; do case "$a" in --now) now=1 ;; -*) ;; *) if [ -z "$verb" ]; then verb=$a; else unit=\${a%.service}; fi ;; esac; done
case "$verb" in
  is-enabled) cat $S/$unit.enabled 2>/dev/null || echo disabled; [ "$(cat $S/$unit.enabled 2>/dev/null)" = enabled ] ;;
  is-active) cat $S/$unit.active 2>/dev/null || echo inactive; [ "$(cat $S/$unit.active 2>/dev/null)" = active ] ;;
  enable) echo enabled > $S/$unit.enabled; [ -n "$now" ] && echo active > $S/$unit.active; true ;;
  disable) [ -n "$now" ] && sleep 2; echo disabled > $S/$unit.enabled; [ -n "$now" ] && echo inactive > $S/$unit.active; true ;;
  start) echo active > $S/$unit.active ;;
  stop) echo inactive > $S/$unit.active ;;
esac
`;

test.beforeEach(() => {
  inPlayer('sh', '-c', `mkdir -p ${STATE} && cp -a /usr/bin/systemctl ${STATE}/systemctl.real &&
    echo enabled > ${STATE}/vsftpd.enabled && echo active > ${STATE}/vsftpd.active && : > ${STATE}/calls`);
  inPlayer('sh', '-c', `cat > /usr/bin/systemctl <<'STUB'\n${STUB}STUB\nchmod 755 /usr/bin/systemctl`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `cp -a ${STATE}/systemctl.real /usr/bin/systemctl && rm -rf ${STATE}`);
});

test('switching FTP off and straight back on leaves it running', async ({ request }) => {
  const off = await request.put('/api/settings/Service_vsftpd', { data: '0' });
  expect(off.ok(), await off.text()).toBe(true);
  const on = await request.put('/api/settings/Service_vsftpd', { data: '1' });
  expect(on.ok(), await on.text()).toBe(true);
  // Both background applies, the 2 s disable included, are done well within this.
  await new Promise((r) => setTimeout(r, 8000));
  const state = inPlayer('sh', '-c', `cat ${STATE}/vsftpd.enabled ${STATE}/vsftpd.active`).trim().split('\n');
  const calls = inPlayer('cat', `${STATE}/calls`);
  // The control: the saves did reach the stand-in.
  expect(calls, 'the stand-in systemctl was never asked about vsftpd').toMatch(/vsftpd/);
  expect(state, `systemctl calls:\n${calls}`).toEqual(['enabled', 'active']);
});
