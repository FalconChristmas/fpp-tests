import { gzipSync } from 'zlib';
import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, setSettingInFile } from './settings-file';
import { keepingFile, keepingSettings } from './privacy-helpers';

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

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARKER = '/tmp/fpp-tests-injected';
// A command that makes MARKER with no '/' in it, for values that become a
// file name.
const TOUCH_MARKER = `touch $(echo ${Buffer.from(MARKER).toString('base64')}|base64 -d)`;

test.beforeEach(() => inPlayer('rm', '-f', MARKER));
test.afterEach(() => inPlayer('rm', '-f', MARKER));

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
