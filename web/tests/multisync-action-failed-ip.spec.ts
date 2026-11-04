import { test, expect } from './fixtures';

// A MultiSync action that fails for a system says which system.  The systems
// list and status are the test's, and so is the failure: the helper the
// action streams from answers with an error.

const REMOTE = '192.0.2.77';
const system = (address: string, hostname: string, uuid: string, local: number) => ({
  address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
  typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
  version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
  channelRanges: '', multiSyncCapable: 1, multisync: false,
  lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
});

test('a restart that fails for a remote names its address', async ({ page }) => {
  // Regression: 53d4cd4d6.  The failure callback gets the log area's id
  // (<row>_logText), which finds no row, so the message read "at undefined".
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system('192.0.2.13', 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(REMOTE, 'fpptests-remote', 'M1-fpptests-remote', 0)] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { [REMOTE]: {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: { Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
      LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', UpgradeSource: 'github.com', Utilization: { CPU: 12, Memory: 34 } },
  } } }));
  await page.route('**/restartRemoteFPPD.php**', (route) => route.fulfill({ status: 500, body: 'no' }));
  const alerts: string[] = [];
  page.on('dialog', (d) => { alerts.push(d.message()); return d.accept(); });

  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  await page.locator('#multiAction').selectOption('restartFPPD');
  await page.locator(`input.remoteCheckbox[name="${REMOTE}"]`).check();
  await page.locator('#performActionButton').click();
  await expect.poll(() => alerts, { timeout: 15_000 }).toContain(`Action failed for FPP system at ${REMOTE}`);
});
