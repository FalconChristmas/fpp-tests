import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Troubleshooting page's PCI tab (troubleshoot-commands.json), run as
// troubleshootingHelper.php runs it. The container may or may not have a PCI
// bus and lspci, so each command's output is checked against every answer its
// script can give; what is fixed is that the tab and its commands exist and
// each ran through the shell to one of them.

test.skip(!container, 'changes the platform and runs the commands inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
let savedPlatform = '';

function setPlatform(p: string) {
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' '${p}' > ${PLATFORM}`);
}

test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
});

async function openTab(page: Page, grp: string) {
  await page.goto('/troubleshooting.php');
  await page.locator(`#pills-${grp}-tab`).click();
  await expect(page.locator(`#pills-${grp}`)).toBeVisible();
}

const hotlink = (page: Page, key: string) =>
  page.locator(`#troubleshooting-hot-links-PCI a[href="#header_${key}"]`);

test('the PCI tab lists the PCI commands and each one answers', async ({ page }) => {
  // Feature: b26cb3f74.  The PCI group was added to troubleshoot-commands.json
  // with its device list, tree, drivers, kernel messages and details commands.
  setPlatform('BeagleBone Black');
  await openTab(page, 'PCI');
  const noBus = /No PCI bus present on this system|lspci not installed/;
  const answers: Record<string, RegExp> = {
    PCIDeviceList: new RegExp(`${noBus.source}|\\[[0-9a-f]{4}:[0-9a-f]{4}\\]`),
    PCIDeviceTree: new RegExp(`${noBus.source}|-\\[[0-9a-f]{4}:[0-9a-f]{2}\\]-|\\[[0-9a-f]{4}:[0-9a-f]{4}\\]`),
    PCIDrivers: /No PCI bus present on this system|driver : /,
    PCIKernelMessages: /No PCI-related kernel messages found|\bPCI|pci/,
    PCIDeviceDetails: new RegExp(`${noBus.source}|Subsystem|Kernel driver in use|Control:`),
  };
  for (const [key, answer] of Object.entries(answers)) {
    await expect(hotlink(page, key), key).toBeVisible();
    const out = page.locator(`#pills-PCI #command_${key}`);
    await expect(out, key).toContainText(answer, { timeout: 30_000 });
  }
});

test('the PCIe device tree command is offered on a Pi only', async ({ page }) => {
  // Feature: b26cb3f74.  PCIeDeviceTreeConfig reads the Pi's pcie@ device
  // tree nodes; its platform is "Raspberry Pi", the rest of the group's "all".
  setPlatform('Raspberry Pi');
  await openTab(page, 'PCI');
  await expect(hotlink(page, 'PCIeDeviceTreeConfig')).toBeVisible();
  await expect(page.locator('#pills-PCI #command_PCIeDeviceTreeConfig'))
    .toContainText(/No PCIe nodes found in the device tree|=== \/proc\/device-tree/, { timeout: 30_000 });

  setPlatform('BeagleBone Black');
  await openTab(page, 'PCI');
  await expect(hotlink(page, 'PCIDeviceList')).toBeVisible();
  await expect(hotlink(page, 'PCIeDeviceTreeConfig')).toHaveCount(0);
});
