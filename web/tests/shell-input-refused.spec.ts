import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, setSettingInFile, snapshotSettings } from './settings-file';

// Request values that reached a root shell, or the page, as given. Each is
// refused, or kept to one quoted word, and runs nothing: the "marker" is a
// file the injected command would have made.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARKER = '/tmp/fpp-tests-injected';
// A command that makes MARKER with no '/' in it, for values that become a URL
// path segment.
const TOUCH_MARKER = `touch $(echo ${Buffer.from(MARKER).toString('base64')}|base64 -d)`;

test.beforeEach(() => inPlayer('rm', '-f', MARKER));
test.afterEach(() => inPlayer('rm', '-f', MARKER));

// Regression: 6c81559b1 ("Harden backup device handling against shell
// injection"). The device name in /api/backups/list/<device> went into
// "file -sL /dev/<device>" as root.
test('a backup device name that is not a device is refused', async ({ request }) => {
  for (const name of [`sda1;${TOUCH_MARKER}`, `$(${TOUCH_MARKER})`]) {
    const r = await request.get(`/api/backups/list/${encodeURIComponent(name)}`);
    expect(await r.text(), name).toContain('ERROR: Invalid device name');
    expect(exists(MARKER), `the device name ran a command: ${name}`).toBe(false);
  }
});

// Regression: e402d6c68 ("Harden against shell injection / SSRF / XSS"). The
// OS image URL went into "sudo wget ... <url> -O ..." unquoted.
test('an OS image URL with shell in it is refused', async ({ request }) => {
  for (const os of [`https://example.invalid/a;touch ${MARKER};/x.fppos`, `https://example.invalid/$(touch ${MARKER})/x.fppos`]) {
    const r = await request.get(`/upgradeOS.php?wrapped=1&downloadOnly=1&os=${encodeURIComponent(os)}`, { timeout: 60_000 });
    const body = await r.text();
    expect(body, os).toContain('Invalid OS URL');
    expect(body).not.toContain('Running command');
    expect(exists(MARKER), `the URL ran a command: ${os}`).toBe(false);
  }
});

// Regression: c9427abaa ("harden test email handling against shell
// injection"). The test email went to "mail -s ... <emailtoemail>" unquoted.
// The settings API refuses such an address now (812dce14e), so it is written
// into the settings file directly, as a hand edit or an older FPP left it.
test('a test email to an address with shell in it runs nothing', async ({ request }) => {
  const restore = snapshotSettings();
  try {
    setSettingInFile('emailtoemail', `fpp-tests@example.com;touch ${MARKER}`);
    const r = await request.post('/api/email/test');
    expect(r.status()).toBe(200);
    expect(exists(MARKER), 'the address ran a command').toBe(false);
  } finally {
    restore();
  }
});

// Regression: be017a4dd ("validate branch and version inputs for git
// operations", #2910). escapeshellcmd() let option-like values through to the
// git scripts: a branch of --upload-pack=<cmd> is an option to git.
test('a branch or version that is not a name is refused', async ({ request }) => {
  const cases: Array<[string, string]> = [
    ['/changebranch.php?branch=--upload-pack=touch', 'Invalid branch'],
    ['/changebranch.php?branch=master..x', 'Invalid branch'],
    [`/changebranch.php?branch=${encodeURIComponent(`m;touch ${MARKER}`)}`, 'Invalid branch'],
    ['/gitCheckoutVersion.php?version=-x', 'Invalid version'],
    [`/upgradefpp.php?version=${encodeURIComponent(`$(touch ${MARKER})`)}`, 'Invalid version'],
  ];
  for (const [url, refusal] of cases) {
    const r = await request.get(url, { timeout: 60_000 });
    const body = await r.text();
    expect(body, url).toContain(refusal);
    expect(body, `${url} ran its command`).not.toContain('Command:');
  }
  expect(exists(MARKER)).toBe(false);
});

// Regression: 7844aa41f ("harden MultiSync rsync + storage scripts against
// shell injection"). copy_settings_to_storage.sh used its path unquoted, so a
// path with a space in it was two paths: the copy made a folder for each word.
// It now takes only a plain folder name. (The commit's other half,
// copyFilesToRemote.php, has since been removed: 307566ca3.)
test('a File Copy path that is not a plain folder name is refused', async ({ request }) => {
  const backups = `${MEDIA}/backups`;
  try {
    for (const path of ['fpp-tests-a fpp-tests-b', 'fpp-tests-a;x']) {
      const r = await request.get('/copystorage.php?wrapped=1&direction=TOLOCAL&flags=Configuration' +
        `&storageLocation=none&remoteStorage=none&path=${encodeURIComponent(path)}`, { timeout: 120_000 });
      const body = await r.text();
      expect(body, path).toContain('Invalid path');
      expect(exists(`${backups}/fpp-tests-a`), `the copy split "${path}"`).toBe(false);
    }
  } finally {
    inPlayer('sh', '-c', `rm -rf ${backups}/fpp-tests-a* ${backups}/fpp-tests-b* /opt/fpp/www/fpp-tests-b`);
  }
});

// Regression: f53dfd621 ("reflected XSS in runEventScript and shell
// arg-boundaries in copystorage"). runEventScript.php echoed its args into the
// page with escapeshellcmd(), which does not encode < or >. copystorage.php
// passed the storage location through escapeshellcmd() too, which does not
// keep a value with a space in it as one word: the script's arguments shifted
// and its direction came out invalid.
test('event script arguments are shown as text, not markup', async ({ request }) => {
  const script = `${MEDIA}/scripts/fpp-tests-args.sh`;
  putFile(script, 'for a in "$@"; do echo "arg[$a]"; done\n');
  try {
    const args = '<img src=x onerror=alert(1)> two';
    const r = await request.get(`/runEventScript.php?scriptName=fpp-tests-args.sh&args=${encodeURIComponent(args)}`);
    const body = await r.text();
    // The control: the script ran with the words as its arguments.
    expect(body).toContain('arg[two]');
    // (What the script prints is its own business; the page's own line is not.)
    const running = body.split('\n').find((l) => l.startsWith('Running fpp-tests-args.sh')) ?? '';
    expect(running, 'the arguments were put into the page as markup').not.toContain('<img');
    expect(running).toContain('&lt;img');
  } finally {
    inPlayer('rm', '-f', script);
  }
});

test('a storage location with a space in it stays one argument', async ({ request }) => {
  // The script checks a remote host's name: given the whole value, it names
  // both words; split, its later arguments shift and the direction is wrong.
  const r = await request.get('/copystorage.php?wrapped=1&direction=TOREMOTE&path=fpp-tests-remote&flags=Configuration' +
    `&storageLocation=${encodeURIComponent('fpp tests')}&remoteStorage=none`, { timeout: 120_000 });
  const body = await r.text();
  expect(body, 'the location split into more arguments').not.toContain('Invalid direction');
  expect(body).toContain('Invalid remote host: fpp tests');
});

// Regression: 220b98075 ("block path traversal in script and cape firmware
// handling", #2920). A script name in /api/scripts/<name> and a firmware file
// name in upgradeCapeFirmware.php were joined to their directories as given.
// (Apache already folds a "../" or an encoded slash out of the API path, so
// what reaches the script routes is a backslash or a bare "..".)
test('a script or firmware name that leaves its directory is refused', async ({ request }) => {
  for (const r of [
    await request.get('/api/scripts/..%5C..%5Csettings'),
    await request.post('/api/scripts/..%5Cx/run'),
    await request.post('/api/scripts/..%5Cx', { data: '"x"' }),
  ]) {
    expect(r.status(), r.url()).toBe(400);
    expect(await r.text()).toContain('Invalid scriptName');
  }
  for (const [fn, refusal] of [
    ['../config/settings', 'traversal not allowed'],
    ['/opt/fpp/capes/../../../home/fpp/media/settings', 'traversal not allowed'],
    ['/tmp/opt/fpp/capes/x.bin', 'Invalid cape file path'],
    ['sub/x.bin', 'Invalid filename'],
  ]) {
    const body = await (await request.get(`/upgradeCapeFirmware.php?filename=${encodeURIComponent(fn)}`, { timeout: 60_000 })).text();
    expect(body, fn).toContain(refusal);
    expect(body, `${fn} was flashed`).not.toContain('Upgrading firmware');
  }
});

// Regression: 6c31528a2 ("branch and version refusals answer 400, not 200").
// Both pages checked the name only after sending the page head, with output
// buffering off, so the 400 they set never reached the client.
test('a refused branch or version answers 400', async ({ request }) => {
  for (const url of ['/changebranch.php?branch=--upload-pack=touch', '/changebranch.php?branch=master..x',
    '/changebranch.php?branch=pr-x&remote=pull-requests', '/gitCheckoutVersion.php?version=-x',
    '/gitCheckoutVersion.php?wrapped=1&version=-x']) {
    const r = await request.get(url, { timeout: 60_000 });
    expect(r.status(), `${url}: ${(await r.text()).slice(0, 200)}`).toBe(400);
  }
});
