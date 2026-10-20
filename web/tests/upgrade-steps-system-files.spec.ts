import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { exists, putFile, readFile, setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Upgrade steps that rewrite system files outside the media directory, run on
// the player the way an FPP update runs them. Each test puts back what it
// changed; none of them reloads Apache.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

function runUpgrade(n: number) {
  return inPlayer('bash', `/opt/fpp/upgrade/${n}/upgrade.sh`);
}

// Keep a system file as it is and put it back afterwards.
function keep(path: string): () => void {
  const had = exists(path);
  const saved = had ? readFile(path) : '';
  return () => (had ? putFile(path, saved) : inPlayer('rm', '-f', path));
}

const PORTS = '/etc/apache2/ports.conf';
const ENVVARS = '/etc/apache2/envvars';

// What upgrade 130 wrote before fpp cc0cc1a04: the IPv6 listener chosen by a
// define that envvars sets at Apache's start.
const OLD_PORTS = `# Managed by FPP -- see configure_apache() in SD/FPP_Install.sh.
<IfDefine FPP_HAVE_IPV6>
Listen [::]:80
</IfDefine>
<IfDefine !FPP_HAVE_IPV6>
Listen 80
</IfDefine>
`;
const OLD_ENVVARS_BLOCK = `
## FPP: only ask apache for the IPv6 wildcard listener when the running
## kernel has IPv6. /proc/sys/net/ipv6 is absent both when the module is
## missing and when the kernel booted with ipv6.disable=1, which are exactly
## the cases where "Listen [::]:80" aborts apache startup.
if [ -d /proc/sys/net/ipv6 ]; then
	export APACHE_ARGUMENTS="\${APACHE_ARGUMENTS} -D FPP_HAVE_IPV6"
fi
`;

// Regression: cc0cc1a04 ("update listener configuration to dynamically handle
// IPv6 support and fix broken 130 upgrade"). The define only existed for an
// Apache master started after upgrade 130 ran; a graceful reload of one
// started before took the "Listen 80" branch on a box bound to [::]:80 and
// left nothing listening on port 80. The listener is now chosen by <IfFile>,
// evaluated on every parse, and upgrade 135 rewrites what 130 left.
test('upgrade 135 replaces the start-time IPv6 define with a check in ports.conf', async () => {
  const restorePorts = keep(PORTS);
  const restoreEnv = keep(ENVVARS);
  const stock = readFile(PORTS);
  try {
    putFile(PORTS, OLD_PORTS);
    putFile(ENVVARS, readFile(ENVVARS) + OLD_ENVVARS_BLOCK);
    runUpgrade(135);
    const ports = readFile(PORTS);
    expect(ports, 'ports.conf still depends on the start-time define').not.toContain('FPP_HAVE_IPV6');
    expect(ports).toContain('<IfFile /proc/sys/net/ipv6>');
    expect(ports).toContain('<IfFile !/proc/sys/net/ipv6>');
    expect(readFile(ENVVARS)).not.toContain('FPP_HAVE_IPV6');
    // The rewritten file is one Apache takes.
    expect(inPlayer('sh', '-c', 'apache2ctl -t 2>&1; echo rc=$?')).toContain('rc=0');

    // A ports.conf FPP did not write is left alone by 135; 130 (which writes
    // its own) no longer adds the define to envvars.
    restorePorts();
    runUpgrade(135);
    expect(readFile(PORTS)).toBe(stock);
    runUpgrade(130);
    expect(readFile(PORTS)).not.toContain('IfDefine');
    expect(readFile(ENVVARS), 'upgrade 130 still adds the start-time define').not.toContain('FPP_HAVE_IPV6');
  } finally {
    restorePorts();
    restoreEnv();
  }
});

// Feature: 3eaece428 ("re-deploy the systemd units on a version upgrade").
// The units in /lib/systemd/system were copied once, at install, so a unit
// change (fppd.service's LimitRTPRIO) never reached an upgraded box. Upgrade
// 142 refreshes the units that are installed, adds none, and does nothing on
// a second run.
test('upgrade 142 refreshes the installed units, and only those', async () => {
  const restoreSettings = snapshotSettings();
  const FPPD = '/lib/systemd/system/fppd.service';
  const OLED = '/lib/systemd/system/fppoled.service';
  // (The test player has no units installed; one stale fppd.service stands in
  // for an image's.)
  const restoreFppd = keep(FPPD);
  const restoreOled = keep(OLED);
  try {
    const current = readFile('/opt/fpp/etc/systemd/fppd.service');
    putFile(FPPD, current.replace(/^LimitRTPRIO=.*\n/m, '') + '# fpp-tests stale copy\n');
    inPlayer('rm', '-f', OLED);
    setSettingInFile('rebootFlag', '0');

    const first = runUpgrade(142);
    expect(first).toContain('Updating fppd.service');
    expect(readFile(FPPD), 'the installed fppd.service was not refreshed').toBe(current);
    expect(exists(OLED), 'a unit this player never installed was added').toBe(false);
    expect(settingInFile('rebootFlag')).toBe('1');

    setSettingInFile('rebootFlag', '0');
    const second = runUpgrade(142);
    expect(second).toContain('All installed units already current');
    expect(settingInFile('rebootFlag')).toBe('0');
  } finally {
    restoreFppd();
    restoreOled();
    restoreSettings();
  }
});

// Coverage: 98eb5688b ("Bring existing systems onto libgstrtspserver, not
// just fresh installs"), upgrade 140. Where the package is already there it
// says so, exits 0 and touches no source.
test('upgrade 140 leaves a player that has the RTSP server library alone', async () => {
  test.skip(!inPlayer('sh', '-c', "dpkg -l libgstrtspserver-1.0-dev 2>/dev/null | grep '^ii' || true").trim(),
    'libgstrtspserver-1.0-dev is not installed here');
  const src = '/opt/fpp/src/mediaoutput/RTSPOutputManager.cpp';
  const before = inPlayer('stat', '-c', '%Y', src).trim();
  const out = inPlayer('sh', '-c', 'bash /opt/fpp/upgrade/140/upgrade.sh; echo rc=$?');
  expect(out).toContain('already installed');
  expect(out).toContain('rc=0');
  expect(inPlayer('stat', '-c', '%Y', src).trim()).toBe(before);
});
