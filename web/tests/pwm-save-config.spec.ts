import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The Channel Outputs PWM tab (co-pwm.php) saving a config for real, and
// coming up with a saved file that holds no PWM output yet.  The tab exists
// only with a signed cape that provides PWM; as in pwm-save-before-load.spec.ts
// the test gives the container one (media/tmp/cape-info.json and its port
// layout in media/tmp/pwm) for the length of each test.  fppd's PCA9685
// output needs an I2C bus the container doesn't have, so the receiving end
// checked is the stored co-pwm.json, as fppd would read it.

test.skip(!container, 'gives the run-web.sh container a PWM cape');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const PWM_FILE = `${MEDIA}/tmp/pwm/FppTestsPWM.json`;
const CONFIG = `${MEDIA}/config/co-pwm.json`;
const CAPE_INFO_JSON = {
  id: 'FppTestsPWM', name: 'fpp-tests PWM', version: '1.0', serialNumber: 'SN0001',
  provides: ['all', 'pwm'], verifiedKeyId: 'ft',
};
const PWM_CAPE = {
  name: 'FppTestsPWM', longName: 'fpp-tests 2-port PWM cape', driver: 'PCA9685',
  outputs: [{ label: 'Port 1' }, { label: 'Port 2' }],
};

function writeFile(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1" && chmod 644 "$1"', 'sh', path, content);
}
function readFile(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}

let kept: Record<string, string | null> = {};
test.beforeEach(() => {
  kept = { [CAPE_INFO]: readFile(CAPE_INFO), [PWM_FILE]: readFile(PWM_FILE), [CONFIG]: readFile(CONFIG) };
  writeFile(CAPE_INFO, JSON.stringify(CAPE_INFO_JSON));
  writeFile(PWM_FILE, JSON.stringify(PWM_CAPE));
});
test.afterEach(() => {
  for (const [p, content] of Object.entries(kept)) {
    if (content === null) inPlayer('rm', '-f', p); else writeFile(p, content);
  }
});

test('with a saved config that has no PWM output, the tab saves the one entered', async ({ page }) => {
  // Regression: 7d7be1685 (#2121).  Save built its POST on a channelOutputs
  // array it never created and threw, so nothing was saved; and a load that
  // found no channelOutputs threw before the page was ready.
  writeFile(CONFIG, '{}');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.dismiss());
  await page.goto('/channeloutputs.php');
  test.skip((await page.locator('#tab-pwm-tab').count()) === 0, 'no PWM cape, so no PWM tab');
  await page.locator('#tab-pwm-tab').click();

  const save = page.locator('#savePWMButton');
  await expect(save, 'Save once the (empty) config has loaded').toBeEnabled({ timeout: 15_000 });
  const description = page.locator('[id^="pwmDescription"]').first();
  await description.fill('fpp-tests saved servo');
  await description.dispatchEvent('change');
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' &&
    new URL(r.url()).pathname === '/api/channel/output/co-pwm', { timeout: 5_000 }).catch(() => null);
  await save.click();
  expect(await posted, 'Save sent nothing').not.toBeNull();
  await expect(page.locator('#jGrowl')).toContainText('PWM/Servo Output Configuration Saved');
  expect(errors).toEqual([]);

  const stored = JSON.parse(readFile(CONFIG) ?? 'null');
  expect(stored?.channelOutputs?.length, JSON.stringify(stored)).toBe(1);
  expect(stored.channelOutputs[0]).toMatchObject({ type: 'PCA9685', subType: 'FppTestsPWM' });
  expect(stored.channelOutputs[0].outputs[0].description).toBe('fpp-tests saved servo');
});
