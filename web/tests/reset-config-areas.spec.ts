import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: d2ece02e4 ("add variables, recurring tasks and command presets
// to Reset FPP Config").  Resetting the Configuration area left the
// variables, the recurring tasks and the command presets behind.  Every file
// the area removes is saved first and put back after, so the player keeps
// its own (its UI password file among them).

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MEDIA = '/home/fpp/media';
const SAVED = '/tmp/fpp-tests-reset-config-areas';
const NEW = ['config/variables.json', 'config/recurringtasks.json', 'config/commandPresets.json'];
// What else the area removes, saved too; and a file of another area, which stays.
const AREA = ['config/.htaccess', 'config/.htpasswd', 'config/authorized_keys', 'config/dns', 'config/gpio.json',
  'config/instantCommand.json', 'config/model-overlays.json', 'config/virtualdisplaymap', 'fpp-info.json',
  'config/cape-eeprom.bin', ...NEW];
const OTHER = 'config/schedule.json';

const present = (f: string) => inPlayer('sh', '-c', `test -e ${MEDIA}/${f} && echo y || echo n`).trim() === 'y';

test('resetting the Configuration area removes the variables, recurring tasks and command presets', async ({ request }) => {
  inPlayer('sh', '-c', `rm -rf ${SAVED} && mkdir -p ${SAVED}/exim4 && cd ${MEDIA} && ` +
    `for f in ${AREA.join(' ')} ${OTHER}; do [ -e "$f" ] && mkdir -p "${SAVED}/$(dirname "$f")" && cp -a "$f" "${SAVED}/$f"; done; ` +
    `[ -d exim4 ] && cp -a exim4/. ${SAVED}/exim4/; true`);
  try {
    inPlayer('sh', '-c', `cd ${MEDIA} && echo '{"fppTestsVar":"1"}' > config/variables.json && ` +
      `echo '[]' > config/recurringtasks.json && echo '{"commands":[]}' > config/commandPresets.json && ` +
      `[ -e ${OTHER} ] || echo '{"schedule":[]}' > ${OTHER}`);
    const r = await request.get('/resetConfig.php?areas=config');
    expect(r.ok()).toBe(true);
    // The control: the reset ran over the area.
    expect(await r.text()).toContain('Area: config');
    for (const f of NEW) {
      expect(present(f), `${f} was left behind`).toBe(false);
    }
    expect(present(OTHER), 'a file of another area was removed').toBe(true);
    // What reads them back: the config file API has nothing to give.
    expect((await request.get('/api/configfile/commandPresets.json')).status()).toBe(404);
  } finally {
    inPlayer('sh', '-c', `cd ${SAVED} && rm -f ${MEDIA}/${OTHER} ${NEW.map((f) => `${MEDIA}/${f}`).join(' ')}; ` +
      `cp -a ${SAVED}/. ${MEDIA}/ 2>/dev/null; rm -rf ${SAVED}`);
  }
});
