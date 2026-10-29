import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { keepingSettings } from './privacy-helpers';

// Changing a BeagleBone LED setting (BBBLeds0-3, BBBLedPWR) applies it at
// once: PutSetting runs `fppinit configureBBB`, the step boot runs.  The
// player is a container, whose fppinit has no BeagleBone LEDs to set, so the
// tree's fppinit is stood in for by a script that records how it was run;
// the device scenario test_fppinit_bb_leds.py runs the real one on a
// BeagleBone and checks the triggers it writes against the board's kernel.

test.skip(!container, 'stands in for fppinit inside the run-web.sh container');

const FPPINIT = '/opt/fpp/src/fppinit';
const LOG = '/tmp/fpp-tests-fppinit.log';

test('changing a BeagleBone LED setting runs fppinit configureBBB as root', async ({ request }) => {
  // Regression: e28eddf0f ("configuring BBB leds shouldn't require a
  // reboot").  PutSetting called SetBBBLeds(), which wrote nothing the
  // boards still used, so a new LED setting only took effect at the next
  // boot's configureBBB.
  inPlayer('cp', '-p', FPPINIT, `${FPPINIT}.fpp-tests-orig`);
  putFile(FPPINIT, `#!/bin/sh\necho "$(id -u) $*" >> ${LOG}\n`);
  inPlayer('sh', '-c', `chmod 755 ${FPPINIT}; rm -f ${LOG}`);
  try {
    await keepingSettings(async () => {
      for (const [name, value] of [['BBBLeds0', 'none'], ['BBBLeds2', 'cpu'], ['BBBLedPWR', '0']]) {
        const r = await request.put(`/api/settings/${name}`, { data: value, headers: { 'Content-Type': 'text/plain' } });
        expect(r.ok(), `${name}: ${await r.text()}`).toBe(true);
      }
      // The control: the settings were saved.
      expect(inPlayer('grep', '-c', '^BBBLeds[02] = ', '/home/fpp/media/settings').trim()).toBe('2');
    });
    const runs = inPlayer('sh', '-c', `cat ${LOG} 2>/dev/null || true`).split('\n').filter((l) => l);
    expect(runs).toEqual(['0 configureBBB', '0 configureBBB', '0 configureBBB']);
  } finally {
    inPlayer('sh', '-c', `mv -f ${FPPINIT}.fpp-tests-orig ${FPPINIT}; rm -f ${LOG}`);
  }
});
