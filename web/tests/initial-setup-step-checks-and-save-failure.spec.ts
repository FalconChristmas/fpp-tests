import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import http from 'http';
import { container, inPlayer } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// The setup wizard's own checks on each step (privacy rules, coordinates,
// host name, the password choices), Back, and what Finish does when a
// setting cannot be saved: it says which, does not mark setup finished, and
// does not turn the UI password on (a password that may not have been
// stored).  The settings file is put back after each test.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// Leaving step 1 asks cape detection for its defaults, which waits for an I2C
// bus the container lacks (initial-setup-privacy-unanswered.spec.ts).
const CAPEDETECT = '/opt/fpp/src/fppcapedetect';

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('initialSetup-02', '0');
  setSettingInFile('passwordEnable', '0');
  inPlayer('sh', '-c', `[ -e ${CAPEDETECT} ] && mv ${CAPEDETECT} ${CAPEDETECT}.fpp-tests || true`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', `[ -e ${CAPEDETECT}.fpp-tests ] && mv ${CAPEDETECT}.fpp-tests ${CAPEDETECT} || true`);
  restoreSettings();
});

function status(path: string): Promise<number> {
  const base = test.info().project.use.baseURL!;
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { agent: false }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject);
  });
}

const step = (page: Page, n: number) => page.locator(`.setupStep[data-step="${n}"]`);

async function open(page: Page, alerts: string[]) {
  page.on('dialog', (d) => { alerts.push(d.message()); return d.accept(); });
  await page.goto('/initialSetup.php');
  await expect(step(page, 1)).toBeVisible();
}
async function next(page: Page, to: number) {
  await page.click('#setupNextBtn');
  await expect(step(page, to)).toBeVisible({ timeout: 60_000 });
}
// Next is refused: the alert is the one given, and the step stays.
async function refused(page: Page, alerts: string[], n: number, msg: string) {
  const before = alerts.length;
  await page.click('#setupNextBtn');
  await expect.poll(() => alerts.length).toBe(before + 1);
  expect(alerts[before]).toContain(msg);
  await expect(step(page, n)).toBeVisible();
}

test('each step refuses what it cannot save, and Back keeps what was entered', async ({ page }) => {
  test.setTimeout(120_000);
  const alerts: string[] = [];
  // Not yet answered, the privacy rules start blank.
  setSettingInFile('LegalJurisdiction', undefined);
  // Nor is the UI password choice.
  setSettingInFile('passwordEnable', undefined);
  await open(page, alerts);

  // Step 1: privacy rules must be chosen; coordinates must be numbers.
  await expect(page.locator('#LegalJurisdiction')).toHaveValue('');
  await refused(page, alerts, 1, 'Please select which privacy rules apply');
  await page.selectOption('#LegalJurisdiction', 'US');
  await page.fill('#Latitude', 'north');
  await refused(page, alerts, 1, 'Latitude must be a number.');
  await page.fill('#Latitude', '-33.86');
  await page.fill('#Longitude', 'east');
  await refused(page, alerts, 1, 'Longitude must be a number.');
  await page.fill('#Longitude', '151.2');
  await next(page, 2);

  // Step 2: a host name RFC 952 takes.
  for (const bad of ['', '-front', 'yard-', 'front_yard', 'front yard']) {
    await page.fill('#HostName', bad);
    await refused(page, alerts, 2, 'Host names must contain only letters, numbers and hyphens');
  }
  await page.fill('#HostName', 'fpp-tests-yard');

  // Back to step 1 and forward again: nothing typed is lost.
  await page.click('#setupBackBtn');
  await expect(step(page, 1)).toBeVisible();
  await expect(page.locator('#Latitude')).toHaveValue('-33.86');
  await expect(page.locator('#Longitude')).toHaveValue('151.2');
  await next(page, 2);
  await expect(page.locator('#HostName')).toHaveValue('fpp-tests-yard');
  await next(page, 3);
  await next(page, 4);

  // Step 4: the UI password must be chosen either way, and match.
  await expect(page.locator('#passwordEnable')).toHaveValue('');
  const finish = async (msg: string) => {
    const before = alerts.length;
    await page.click('#finishSetupBtn');
    await expect.poll(() => alerts.length).toBe(before + 1);
    expect(alerts[before]).toContain(msg);
    await expect(step(page, 4)).toBeVisible();
  };
  await finish('You must choose to either Enable or Disable the UI password.');
  await page.selectOption('#passwordEnable', '1');
  await page.fill('#password', 'fpp-tests-one');
  await page.fill('#passwordVerify', 'fpp-tests-two');
  await finish('The UI password and its confirmation do not match.');
  if (await page.locator('#osPasswordEnable').isVisible()) {
    await page.selectOption('#passwordEnable', '0');
    await page.selectOption('#osPasswordEnable', '');
    await finish('You must choose to either use the default OS password or choose a custom password.');
  }

  // Nothing was saved by any of it.
  expect(settingInFile('initialSetup-02')).toBe('0');
  expect(settingInFile('passwordEnable')).toBeUndefined();
  expect(settingInFile('HostName')).not.toBe('fpp-tests-yard');
});

test('a setting that fails to save stops Finish before setup is marked done or the password is turned on', async ({ page }) => {
  test.setTimeout(240_000);
  const alerts: string[] = [];
  const latitude = settingInFile('Latitude');
  let refusedOnce = 0;
  await page.route('**/api/settings/Latitude**', (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    refusedOnce++;
    return r.fulfill({ status: 500, body: 'fpp-tests refusal' });
  });
  const puts: string[] = [];
  page.on('request', (q) => { if (q.method() === 'PUT' && q.url().includes('/api/settings/')) puts.push(new URL(q.url()).pathname.replace('/api/settings/', '')); });

  await open(page, alerts);
  if (await page.locator('#LegalJurisdiction').count()) await page.selectOption('#LegalJurisdiction', 'US');
  await page.fill('#Latitude', '-31.95');
  await page.fill('#Longitude', '115.86');
  await next(page, 2);
  await next(page, 3);
  await next(page, 4);
  await page.selectOption('#passwordEnable', '1');
  await page.fill('#password', 'fpp-tests-unsaved');
  await page.fill('#passwordVerify', 'fpp-tests-unsaved');
  if (await page.locator('#osPasswordEnable').isVisible()) await page.selectOption('#osPasswordEnable', '0');
  await page.click('#finishSetupBtn');

  const dlg = page.locator('#dialogOKPopup');
  await expect(dlg).toContainText('Failed to save: Latitude', { timeout: 60_000 });
  expect(refusedOnce).toBe(1);
  await expect(page).toHaveURL(/initialSetup\.php/);
  await expect(page.locator('#finishSetupBtn')).toBeEnabled();
  await expect(page.locator('#setupProgress')).toBeHidden();
  // Not finished, no password: the UI still answers without one.
  expect(settingInFile('initialSetup-02')).toBe('0');
  expect(settingInFile('passwordEnable')).toBe('0');
  expect(puts).not.toContain('initialSetup-02');
  expect(puts).not.toContain('passwordEnable');
  expect(puts).not.toContain('password');
  expect(await status('/api/fppd/version')).toBe(200);
  expect(settingInFile('Latitude')).toBe(latitude);

  // Fixed and finished again (without the password this time), it completes.
  await page.unroute('**/api/settings/Latitude**');
  await dlg.locator('.modal-footer button', { hasText: 'Close' }).click();
  await page.selectOption('#passwordEnable', '0');
  await page.click('#finishSetupBtn');
  await expect(page).toHaveURL(/index\.php/, { timeout: 60_000 });
  expect(settingInFile('initialSetup-02')).toBe('1');
  expect(settingInFile('Latitude')).toBe('-31.95');
  expect(settingInFile('passwordEnable')).toBe('0');
});
