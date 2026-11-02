import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, setSettingInFile, snapshotSettings } from './settings-file';

// Provisioning a network interface before it exists (the Network page's
// "Add New Interface", POST /api/network/interface/add/<name>): the saved
// config is listed, marked "(not detected)", while the adapter is absent.
// The receiving end is the real fppinit setupNetwork, which writes the
// systemd-networkd file for each config/interface.<name>.

test.skip(!container, 'writes interface configs and runs fppinit inside the run-web.sh container');

const CONFIG = `${MEDIA}/config`;
const NETDIR = '/etc/systemd/network';
const NAME = 'eth7';

function cat(path: string): string {
  return inPlayer('sh', '-c', `cat '${path}' 2>/dev/null || true`);
}

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('uiLevel', '1');
  inPlayer('rm', '-f', `${CONFIG}/interface.${NAME}`);
});
test.afterEach(() => {
  restoreSettings();
  inPlayer('sh', '-c', `rm -f ${CONFIG}/interface.${NAME} ${NETDIR}/10-${NAME}.network`);
});

test('an interface added before it exists is listed, and is a config networkd can use', async ({ page, request }) => {
  // Feature: 8d350446f ("Provision interfaces before they exist").
  // Regression: 6eb71e493.  The new interface's config was an empty file, so
  // setting the interface up from it wrote a broken networkd file; it now
  // starts as a DHCP interface.
  // Also d35ec7783: the dialog's OK button read the new name from itself, not
  // the dialog, so it posted an empty name and nothing was added.
  await page.goto('/networkconfig.php');
  await page.getByRole('button', { name: /Add New Interface/ }).click();
  const dialog = page.locator('#addNewInterfaceDialog');
  await dialog.locator('.newInterfaceName').fill(NAME);
  await expect(dialog).toHaveClass(/show/);
  await page.waitForTimeout(500);
  await dialog.getByRole('button', { name: 'OK' }).click();
  // The page reloads with the new interface on its list.
  await expect(page.locator(`#selInterfaces option[value="${NAME}"]`)).toHaveText(`${NAME} (not detected)`, { timeout: 15_000 });

  expect(cat(`${CONFIG}/interface.${NAME}`)).toBe(`INTERFACE=${NAME}\nPROTO=dhcp\n`);
  const saved = await (await request.get(`/api/network/interface/${NAME}`)).json();
  expect(saved.PROTO).toBe('dhcp');

  inPlayer('sh', '-c', 'timeout 120 /opt/fpp/src/fppinit setupNetwork > /dev/null 2>&1 || true');
  const net = cat(`${NETDIR}/10-${NAME}.network`);
  expect(net).toContain(`Name=${NAME}`);
  expect(net).toContain('DHCP=');
});

test('adding an interface that is already there, or has a bad name, changes nothing', async ({ request }) => {
  // Feature: 8d350446f.
  expect((await (await request.post(`/api/network/interface/add/${NAME}`)).json()).status).toBe('New Blank Interface created');
  const first = cat(`${CONFIG}/interface.${NAME}`);
  expect(first).not.toBe('');
  expect((await (await request.post(`/api/network/interface/add/${NAME}`)).json()).status).toBe('ERROR: Interface already exists');
  expect(cat(`${CONFIG}/interface.${NAME}`)).toBe(first);
  const bad = await (await request.post('/api/network/interface/add/7eth')).json();
  expect(bad.status).toMatch(/^ERROR: must be in format/);
  expect(cat(`${CONFIG}/interface.7eth`)).toBe('');
});
