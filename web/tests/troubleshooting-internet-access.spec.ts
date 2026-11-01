import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { FakeHttps } from './fake-https';

// The Troubleshooting page's Internet Access command (Networking tab) asks
// whether GitHub can be reached with an HTTPS request, not a ping: GitHub
// does not answer ICMP, so a player with working internet read as offline.
//
// Regression: 39880bc53 ("Change internet/Github availability checks due to
// ICMP being blocked by GitHub").  The command was `ping -c 1 github.com`.
// The HTTPS stand-in for GitHub (fake-https.ts) answers the README the
// command fetches; ping is made to fail, as it does against the real host.

test.skip(!container, 'stands in for GitHub inside the run-web.sh container');

const BIN = '/usr/local/sbin';
const README = '/FalconChristmas/fpp/blob/master/README.md';
let fake: FakeHttps;

test.beforeEach(() => {
  fake = new FakeHttps(['github.com'], { [`github.com ${README}`]: { status: 200, body: '# FPP' } });
  fake.start();
  putFile(`${BIN}/ping`, '#!/bin/sh\n# fpp-tests stand-in: ICMP to this host gets no answer\necho "ping: no reply"\nexit 1\n');
  inPlayer('chmod', '755', `${BIN}/ping`);
});
test.afterEach(() => {
  fake.stop();
  inPlayer('rm', '-f', `${BIN}/ping`);
});

async function internetAccess(page: Page): Promise<string> {
  await page.goto('/troubleshooting.php');
  await page.locator('#pills-Networking-tab').click();
  const out = page.locator('#pills-Networking #command_InternetAccess');
  await expect(out).toContainText(/GitHub reachable/i, { timeout: 30_000 });
  return out.innerText();
}

test('Internet Access reports GitHub reachable over HTTPS although ping gets no answer', async ({ page }) => {
  expect(await internetAccess(page)).toContain('GitHub reachable: **YES**');
  expect(fake.requests().some((r) => r.host === 'github.com' && r.path === README),
    'the command never asked GitHub for the README').toBe(true);
});

test('Internet Access reports not reachable when GitHub does not answer HTTPS', async ({ page }) => {
  fake.down();
  expect(await internetAccess(page)).toContain('GitHub Reachable: ** NO **');
});
