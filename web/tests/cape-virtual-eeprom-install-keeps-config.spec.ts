import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Installing one of FPP's own virtual EEPROM images (upgradeCapeFirmware.php
// with a /opt/fpp/capes/... name) used to throw away the string/pixel output
// config.  It is thrown away only to replace a cape already installed (the old
// EEPROM's outputs mean nothing on the new one), not on a first install.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const EEPROM = `${MEDIA}/config/cape-eeprom.bin`;
const FILES = [`${MEDIA}/config/co-pixelStrings.json`, `${MEDIA}/config/co-bbbStrings.json`];
const KEEP = '/tmp/fpp-tests-eeprom-keep';

const exists = (p: string) => inPlayer('sh', '-c', 'test -e "$1" && echo yes || echo no', 'sh', p).trim() === 'yes';

test.beforeEach(() => {
  inPlayer('sh', '-c', `rm -rf ${KEEP} && mkdir -p ${KEEP} && for f in ${EEPROM} ${FILES.join(' ')}; do ` +
    `if [ -e $f ]; then cp -a $f ${KEEP}/; fi; done; rm -f ${EEPROM}`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `rm -f ${EEPROM} ${FILES.join(' ')}; for f in ${KEEP}/*; do [ -e "$f" ] && ` +
    `cp -a "$f" ${MEDIA}/config/; done; rm -rf ${KEEP}; true`);
});

const install = async (request: any) => (await request.get('/upgradeCapeFirmware.php?filename=' +
  encodeURIComponent('/opt/fpp/capes/virtual/strings/X11.json'), { timeout: 90_000 })).text();

test('installing a virtual EEPROM on a player with none keeps its output config', async ({ request }) => {
  // Regression: 1acf92695.  The install deleted co-pixelStrings.json and
  // co-bbbStrings.json unconditionally, so a first virtual EEPROM install
  // (nothing to replace) wiped the outputs already set up.
  for (const f of FILES) inPlayer('sh', '-c', `printf '{"channelOutputs":[]}' > ${f}`);
  await install(request);
  for (const f of FILES) expect(exists(f), `${f} was removed by a first install`).toBe(true);
});

test('installing a virtual EEPROM over an installed one drops the old output config', async ({ request }) => {
  // The control for the test above: the cleanup still happens when an EEPROM
  // is being replaced, so the keep is down to the condition and not to the
  // install failing before it got there.
  inPlayer('sh', '-c', `printf 'FPP02' > ${EEPROM}`);
  for (const f of FILES) inPlayer('sh', '-c', `printf '{"channelOutputs":[]}' > ${f}`);
  await install(request);
  for (const f of FILES) expect(exists(f), `${f} survived a replace`).toBe(false);
});
