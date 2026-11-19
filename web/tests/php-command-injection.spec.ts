import { gzipSync } from 'zlib';
import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, setSettingInFile } from './settings-file';
import { keepingFile, keepingSettings } from './privacy-helpers';
import { netAdmin } from './wifi-stubs';

// Regression: 989c2dfc0 ("fix(php): Command injection vulnerabilities in web
// UI"). A sequence file name, the storage device, the NTP server, the OS
// password, the clock date and time, the audio mixer device and an event
// script name each reached a root shell inside quotes they could close, or
// none at all. Each test sends a value that runs a command if it reaches the
// shell as code; the receiving end is that shell: the "marker" is the file the
// command would have made, and, where the value has somewhere to go, the
// program it was meant for got it as one argument.
//
// The commit's other sites are guarded by later fixes as well, and tested
// with those: the time zone (IsValidTimeZone()), the File Copy path
// (shell-input-refused.spec.ts) and the cape firmware URL (a public-host
// check before the download). Its remote script install has been removed.
//
// #3192 is the same kind of gap in two more places: an interface name from
// /sys/class/net went into co-ledPanels.php's ethtool command and into
// network_persistentNames_create()'s ip/cat/mv commands bare, and the LED
// Panels option rendered it as HTML. Those tests add a dummy interface named
// with shell metacharacters, by a sibling container with NET_ADMIN (the
// player itself has none).

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARKER = '/tmp/fpp-tests-injected';
// A command that makes MARKER with no '/' in it, for values that become a
// file name.
const TOUCH_MARKER = `touch $(echo ${Buffer.from(MARKER).toString('base64')}|base64 -d)`;

// Interface names are at most 15 bytes and may not contain '/' or
// whitespace, so the marker has no '/' in the name: a redirection with no
// command makes the file in the shell's working directory, which for
// php-fpm is '/'.
const INJECT_IFACE = 'x;>fppinj';
const HTML_IFACE = "a'<b>c";
const NET_MARKER = '/fppinj';
const NET_MARKER_LINK = '/fppinj.link';
const NETDIR = '/etc/systemd/network';
const ETHTOOL = '/usr/local/bin/ethtool';
const ETHTOOL_LOG = '/tmp/fpp-tests-ethtool-args.log';

// A shell word for the interface name, for the netAdmin script.
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function dummyInterface(name: string, add: boolean) {
  netAdmin(add
    ? `ip link del ${shq(name)} 2>/dev/null; ip link add name ${shq(name)} type dummy`
    : `ip link del ${shq(name)} 2>/dev/null || true`);
}

test.beforeEach(() => inPlayer('rm', '-f', MARKER, NET_MARKER, NET_MARKER_LINK, ETHTOOL_LOG));
test.afterEach(() => {
  inPlayer('rm', '-f', MARKER, NET_MARKER, NET_MARKER_LINK, ETHTOOL_LOG, ETHTOOL);
  if (container) {
    dummyInterface(INJECT_IFACE, false);
    dummyInterface(HTML_IFACE, false);
  }
});

test('a gzipped sequence whose name has shell in it is unzipped under that name', async ({ request }) => {
  const name = `fpp-tests-$(${TOUCH_MARKER})`;
  const content = Buffer.from('PSEQ fpp-tests sequence body\n');
  putFile(`${MEDIA}/upload/${name}.fseq.gz`, gzipSync(content));
  try {
    const r = await request.get(`/api/file/move/${encodeURIComponent(`${name}.fseq.gz`)}`);
    expect(await r.json()).toMatchObject({ status: 'OK' });
    expect(exists(MARKER), 'the file name ran a command').toBe(false);
    // gunzip got the whole name: the sequence is there, unzipped.
    expect(readFile(`${MEDIA}/sequences/${name}.fseq`)).toBe(content.toString());
  } finally {
    inPlayer('sh', '-c', `rm -f ${MEDIA}/upload/fpp-tests-* ${MEDIA}/sequences/fpp-tests-*`);
  }
});

test('a storage device with shell in it runs nothing', async ({ request }) => {
  await keepingSettings(() => keepingFile('/etc/fstab', async () => {
    const r = await request.put('/api/settings/storageDevice?skipBackup=1', { data: `sda1;touch ${MARKER};#` });
    expect(r.ok(), await r.text()).toBe(true);
    expect(exists(MARKER), 'the device name ran a command').toBe(false);
  }));
});

test('an NTP server with shell in it runs nothing', async ({ request }) => {
  const conf = '/etc/chrony/chrony.conf';
  inPlayer('mkdir', '-p', '/etc/chrony');
  await keepingSettings(() => keepingFile(conf, async () => {
    putFile(conf, 'pool pool.example.invalid iburst\ndriftfile /var/lib/chrony/chrony.drift\nmakestep 1 3\n');
    const r = await request.put('/api/settings/ntpServer?skipBackup=1', { data: `x' /dev/null ; touch ${MARKER} ; echo '` });
    expect(r.ok(), await r.text()).toBe(true);
    expect(exists(MARKER), 'the server name ran a command').toBe(false);
    // chrony's config names one server for it, the value kept to one word.
    // (The other line is the default gateway, added as a fallback.)
    const servers = readFile(conf).split('\n').filter((l) => /^(server|pool) /.test(l) && !l.includes('minpoll 10'));
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatch(/^server [A-Za-z0-9.-]+ iburst$/);
  }));
});

// The player has no fpp account, so the test makes one for its length; the
// receiving end is the real chpasswd, checked with the system's own crypt().
test('an OS password with shell in it is set as the password', async ({ request }) => {
  const hadUser = inPlayer('sh', '-c', 'id fpp >/dev/null 2>&1 && echo y || echo n').trim() === 'y';
  test.skip(hadUser, 'the player has an fpp account of its own');
  inPlayer('sh', '-c', "useradd -M -d /home/fpp fpp && echo 'fpp:fpp-tests-before' | chpasswd");
  const isPassword = (password: string) => inPlayer('perl', '-e',
    'my ($h, $p) = @ARGV; print crypt($p, $h) eq $h ? "yes" : "no"',
    inPlayer('sh', '-c', 'getent shadow fpp | cut -d: -f2').trim(), password).trim() === 'yes';
  try {
    await keepingSettings(async () => {
      const password = `x'; touch ${MARKER}; echo '`;
      const r = await request.put('/api/settings/osPassword?skipBackup=1', { data: password });
      expect(r.ok(), await r.text()).toBe(true);
      expect(exists(MARKER), 'the password ran a command').toBe(false);
      expect(isPassword(password), 'chpasswd did not get the password as it was typed').toBe(true);
    });
  } finally {
    inPlayer('userdel', 'fpp');
  }
});

// The container has no CAP_SYS_TIME, so date -s fails whatever it is given.
test('a clock date or time with shell in it runs nothing', async ({ request }) => {
  await keepingSettings(async () => {
    for (const setting of ['ClockDate', 'ClockTime']) {
      const r = await request.put(`/api/settings/${setting}?skipBackup=1`, { data: `$(touch ${MARKER})` });
      expect(r.ok(), await r.text()).toBe(true);
      expect.soft(exists(MARKER), `the ${setting} value ran a command`).toBe(false);
      inPlayer('rm', '-f', MARKER);
    }
  });
});

// The container has no sound card: a stand-in amixer records its arguments,
// one per [...].  "amixer -c <card> set <control> -- <n>%" is the real
// amixer's syntax for a control named in one argument.
test('a mixer device with shell in it is passed to amixer as one name', async ({ request }) => {
  // Also 6924aff8a: the name went into setVolume()'s amixer command bare, so
  // a control with a space in its name reached amixer as several arguments.
  // (fppd's own amixer call: scenarios/test_alsa_mixer_name.py.)
  const control = `PCM'; touch ${MARKER}; echo '`;
  const log = '/tmp/fpp-tests-amixer-args.log';
  putFile('/usr/local/bin/amixer', `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done >> ${log}\necho >> ${log}\n`);
  inPlayer('chmod', '755', '/usr/local/bin/amixer');
  try {
    await keepingSettings(async () => {
      // The amixer call is the one that ALSA (not PipeWire) players make.
      setSettingInFile('MediaBackend', 'alsa');
      setSettingInFile('AudioMixerDevice', control);
      const r = await request.post('/api/system/volume', { data: { volume: 40 } });
      expect(r.ok(), await r.text()).toBe(true);
      expect(exists(MARKER), 'the mixer device ran a command').toBe(false);
      expect(readFile(log).trim().split('\n')).toContain(`[-c][0][set][${control}][--][40%]`);
    });
  } finally {
    inPlayer('rm', '-f', '/usr/local/bin/amixer', log);
  }
});

// The player has no ethtool; a stand-in records its arguments, one per [...],
// and reports a link speed, which the page shows beside the interface.
test('an interface name with shell in it reaches ethtool as one name', async ({ page }) => {
  // Regressions: 2684c2789 and 9532283ff (#3192).  PopulateEthernetInterfaces()
  // put the name from /sys/class/net into "sudo ethtool $iface" bare, so a
  // name containing ';' started a second command.
  dummyInterface(INJECT_IFACE, true);
  putFile(ETHTOOL, `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done >> ${ETHTOOL_LOG}\necho >> ${ETHTOOL_LOG}\necho 'Speed: 1000Mb/s'\n`);
  inPlayer('chmod', '755', ETHTOOL);
  const res = await page.goto('/channeloutputs.php');
  expect(res!.ok(), await res!.text()).toBe(true);

  // The control: the interface reached the list, with ethtool's speed.
  const option = page.locator('#divLEDPanelsTemplate select.LEDPanelsInterface option').filter({ hasText: INJECT_IFACE });
  await expect(option).toHaveCount(1);
  await expect(option).toHaveText(`${INJECT_IFACE} (1000Mbps)`);
  expect(exists(NET_MARKER), 'the interface name ran a command').toBe(false);

  // ethtool also ran for the player's own interfaces; only the test's name
  // matters here.
  const calls = inPlayer('sh', '-c', `cat ${ETHTOOL_LOG} 2>/dev/null || true`).trim().split('\n').filter(Boolean);
  expect(calls, `ethtool calls: ${calls}`).toContain(`[${INJECT_IFACE}]`);
  expect(calls, `ethtool got only part of the name: ${calls}`).not.toContain('[x]');
});

test('an interface name with markup in it is escaped in the LED Panels list', async ({ page }) => {
  // Regression: 8bd867240 (#3192).  The <option> value and label used the
  // name unchanged, so a name with a quote and a tag closed the attribute and
  // added markup.
  dummyInterface(HTML_IFACE, true);
  const res = await page.goto('/channeloutputs.php');
  const body = await res!.text();
  const escaped = 'a&#039;&lt;b&gt;c';
  expect(body).toContain(`value='${escaped}'`);
  expect(body).toContain(`>${escaped} (`);
});

test('creating persistent names with shell in an interface name runs nothing', async ({ request }) => {
  // Regression: 2684c2789 (#3192).  network_persistentNames_create() put the
  // name from /sys/class/net into "ip link show", "cat /sys/class/net/..."
  // and the .link "mv" bare.  The receiving end is the .link file systemd
  // reads: the file written for the interface is the one that is moved.
  dummyInterface(INJECT_IFACE, true);
  try {
    const r = await request.post('/api/network/persistentNames');
    const body = await r.text();
    expect(r.ok(), body).toBe(true);
    expect(JSON.parse(body).status).toBe('OK');
    expect(exists(NET_MARKER), 'the interface name ran a command').toBe(false);
    expect(exists(NET_MARKER_LINK), 'the interface name ran a command').toBe(false);

    const files = inPlayer('sh', '-c', `ls -1 ${NETDIR} 2>/dev/null || true`).trim().split('\n').filter(Boolean);
    const file = files.find((f) => f.endsWith(`-fpp-${INJECT_IFACE}.link`));
    expect(file, `the link files: ${files}`).toBeTruthy();
    expect(inPlayer('cat', `${NETDIR}/${file}`)).toContain(`Name=${INJECT_IFACE}\n`);
  } finally {
    const files = inPlayer('sh', '-c', `ls -1 ${NETDIR} 2>/dev/null || true`).trim().split('\n').filter(Boolean);
    for (const file of files.filter((f) => f.endsWith(`-fpp-${INJECT_IFACE}.link`))) {
      inPlayer('rm', '-f', `${NETDIR}/${file}`);
    }
  }
});

test('clearing persistent names removes every fpp link file', async ({ request }) => {
  // Regression: 1bf1052be (#3192).  The old "rm ... 5?-fpp-*.link"
  // glob only matched a single digit after the 5, so files numbered 510 and
  // above survived a clear.
  inPlayer('sh', '-c', `mkdir -p ${NETDIR}; for n in 0 1 2 3 4 5 6 7 8 9 10 11; do touch ${NETDIR}/5\${n}-fpp-x.link; done; touch ${NETDIR}/510-fpp-x.link`);
  try {
    const r = await request.delete('/api/network/persistentNames');
    expect(r.ok(), await r.text()).toBe(true);
    const files = inPlayer('sh', '-c', `ls -1 ${NETDIR} 2>/dev/null || true`).trim().split('\n').filter(Boolean);
    expect(files.filter((f) => /-fpp-.*\.link$/.test(f)), `leftover link files: ${files}`).toHaveLength(0);
  } finally {
    inPlayer('sh', '-c', `rm -f ${NETDIR}/*-fpp-*.link`);
  }
});

test('an event script outside the scripts folder is not run', async ({ request }) => {
  const outside = '/tmp/fpp-tests-outside.sh';
  putFile(outside, `#!/bin/sh\ntouch ${MARKER}\n`);
  try {
    // The control: a script in the scripts folder runs.
    putFile(`${MEDIA}/scripts/fpp-tests-inside.sh`, `#!/bin/sh\ntouch ${MARKER}\n`);
    await request.get('/runEventScript.php?nohtml=1&scriptName=fpp-tests-inside.sh');
    expect(exists(MARKER), 'the control script did not run').toBe(true);
    inPlayer('rm', '-f', MARKER);

    const body = await (await request.get(`/runEventScript.php?nohtml=1&scriptName=${encodeURIComponent(`../../../..${outside}`)}`)).text();
    expect(exists(MARKER), 'a script outside the scripts folder ran').toBe(false);
    expect(body).toContain('Unknown script');
  } finally {
    inPlayer('rm', '-f', outside, `${MEDIA}/scripts/fpp-tests-inside.sh`);
  }
});
