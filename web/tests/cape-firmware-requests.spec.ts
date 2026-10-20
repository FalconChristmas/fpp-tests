import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The cape EEPROM pages take a firmware name or URL from the request, and an
// EEPROM location from media/tmp/eeprom_location.txt -- a file anyone who can
// reach the UI can write.  What either names ends up in a root shell command
// or flashed onto the cape, so each is held to what it is meant to be.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';

function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e "$1" && echo yes || echo no`, 'sh', path).trim() === 'yes';
}

test('a firmware name that climbs out of the capes directory is refused', async ({ request }) => {
  // Regression: 220b98075.  Any name containing /opt/fpp/capes was taken as
  // FPP's own virtual EEPROM image: "/opt/fpp/capes/../../../etc/hostname"
  // was installed as the cape EEPROM (and cape detection run on it).
  // shell-input-refused.spec.ts checks the refusal messages; this checks the
  // effect, that nothing is installed as the EEPROM.
  const eeprom = `${MEDIA}/config/cape-eeprom.bin`;
  expect(exists(eeprom), 'a cape EEPROM is already installed, so this proves nothing').toBe(false);
  try {
    const r = await request.get('/upgradeCapeFirmware.php?filename=' +
      encodeURIComponent('/opt/fpp/capes/../../../etc/hostname'), { timeout: 60_000 });
    const body = await r.text();
    expect(exists(eeprom), `a file outside capes/ was installed as the EEPROM:\n${body}`).toBe(false);
    expect(body).toContain('traversal not allowed');

    // An upload is a plain name in the upload directory.
    const sub = await (await request.get('/upgradeCapeFirmware.php?filename=' +
      encodeURIComponent('subdir/fpp-tests.bin'), { timeout: 60_000 })).text();
    expect(sub).toContain('Invalid filename');
  } finally {
    inPlayer('rm', '-f', eeprom);
  }
});

test('a firmware URL on this host or its network is not fetched', async ({ request }) => {
  // Regression: d384f8c4a.  Any http URL was downloaded server-side and
  // flashed: a URL into the box's own services, its LAN, or a cloud metadata
  // address was fetched by the box for whoever asked.
  const tmp = `${MEDIA}/tmp/tmp-eeprom.bin`;
  for (const url of ['http://127.0.0.1/api/fppd/version', 'http://169.254.169.254/latest/meta-data/',
                     'http://10.0.0.1/firmware.bin']) {
    const body = await (await request.get('/upgradeCapeFirmware.php?filename=' + encodeURIComponent(url),
      { timeout: 60_000 })).text();
    expect(body, `${url} was fetched`).not.toContain('Connecting to');
    expect(body, url).toContain('Invalid firmware URL');
    expect(exists(tmp), `${url} was downloaded`).toBe(false);
  }
});

test('an EEPROM location that is shell text is not run', async ({ request }) => {
  // Regression: d384f8c4a.  eeprom_location.txt (CapeUtils writes it, but it
  // lives in web-writable media/tmp) went unquoted into "sudo dd if=...": a
  // location naming an existing file whose path held ";touch ..." ran that
  // as root when the signing data was read.
  const dir = `${MEDIA}/tmp/x;touch /tmp/fpp-tests-eep;`;
  const location = `${dir}/e`;
  const marker = '/tmp/fpp-tests-eep';
  inPlayer('rm', '-f', marker);
  inPlayer('mkdir', '-p', dir);
  inPlayer('sh', '-c', 'printf "FPP02" > "$1" && printf "%s" "$1" > "$2"', 'sh', location,
           `${MEDIA}/tmp/eeprom_location.txt`);
  try {
    await request.get('/api/cape/eeprom/signingData/FPPTESTS/1', { timeout: 60_000 });
    expect(exists(marker), 'the EEPROM location was run as shell').toBe(false);
  } finally {
    inPlayer('rm', '-rf', `${MEDIA}/tmp/x;touch `, `${MEDIA}/tmp/eeprom_location.txt`, marker,
             `${MEDIA}/config/tmpEEPROM.bin`);
  }
});
