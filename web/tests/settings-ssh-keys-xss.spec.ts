import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures';

// Regression test for FalconChristmas/fpp#3175: authorized_keys content was
// echoed into the Settings -> System SSH Keys <textarea> without escaping
// (stored XSS). Fix commit: c9b9e96759cc9aaf0626dc82d0dfce7719375a64.
//
// The SSH Keys block only renders when $showOSSecurity is set (platform file
// present, /etc/fpp/container absent) and uiLevel >= 1, so the test moves the
// container marker aside for its duration, like other specs here.

const NAME = process.env.FPP_TESTS_WEB_CONTAINER;
const CONTAINER = '/etc/fpp/container';
const ASIDE = '/etc/fpp/container.fpp-tests-aside';
const PLATFORM = '/etc/fpp/platform';
const KEYS = '/root/.ssh/authorized_keys';
const KEYS_ASIDE = '/root/.ssh/authorized_keys.fpp-tests-aside';

const PAYLOAD =
  `</textarea><img src=x onerror="window.__xss=1">\n` +
  `ssh-ed25519 AAAA test&key "quoted" 'single' <b>bold</b>\n`;

function sh(cmd: string, input?: string) {
  return execFileSync('docker', ['exec', '-i', NAME!, 'sh', '-c', cmd], {
    input,
    encoding: 'utf8',
  });
}

test.skip(!NAME, 'needs FPP_TESTS_WEB_CONTAINER (run via run-web.sh)');

let uiLevel = '0';
let madePlatform = false;

test.beforeAll(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);

  sh(`[ -e ${CONTAINER} ] && mv ${CONTAINER} ${ASIDE}; true`);
  madePlatform = sh(`[ -e ${PLATFORM} ] || { touch ${PLATFORM}; echo made; }`).includes('made');
  sh(`mkdir -p /root/.ssh; [ -e ${KEYS} ] && cp -p ${KEYS} ${KEYS_ASIDE}; true`);
  sh(`cat > ${KEYS}`, PAYLOAD);
});

test.afterAll(async ({ request }) => {
  sh(`if [ -e ${KEYS_ASIDE} ]; then mv ${KEYS_ASIDE} ${KEYS}; else rm -f ${KEYS}; fi`);
  if (madePlatform) sh(`rm -f ${PLATFORM}`);
  sh(`[ -e ${ASIDE} ] && mv ${ASIDE} ${CONTAINER}; true`);
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

test('authorized_keys content is shown as text, not markup', async ({ page }) => {
  let dialog = false;
  page.on('dialog', async (d) => { dialog = true; await d.dismiss(); });

  await page.goto('/settings.php?tab=System');
  const keys = page.locator('#sshKeys');
  await expect(keys).toBeAttached();

  // Round-trips byte for byte once the browser decodes the entities.
  await expect(keys).toHaveValue(PAYLOAD);

  // Nothing escaped the textarea.
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialog).toBe(false);
});
