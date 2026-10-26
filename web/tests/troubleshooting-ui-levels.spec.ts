import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile, readFile, setSettingInFile, snapshotSettings } from './settings-file';

// The Troubleshooting page's UI levels and its Dev Tools tab.  A group or a
// command in troubleshoot-commands.json can carry a "level" (what it means in
// settings.json: 0 Basic .. 3 Developer); the page leaves out what is above
// the UI level, while a Diagnostic Report (troubleshootingText.php
// --manual-crash-report, which generate_crash_report runs as root) still runs
// it -- that report is the other end the commands reach.

test.skip(!container, 'runs the troubleshooting commands inside the run-web.sh container');

const COMMANDS = '/opt/fpp/www/troubleshoot-commands.json';

let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

async function setLevel(request: APIRequestContext, level: number) {
  expect((await request.put('/api/settings/uiLevel', { data: String(level) })).ok()).toBe(true);
}

async function openTroubleshooting(page: Page) {
  await page.goto('/troubleshooting.php');
  await expect(page.locator('#pills-tab .nav-link').first()).toBeVisible();
}

// What a Diagnostic Report gets from the troubleshooting commands.
function diagnosticReport(): string {
  return inPlayer('sh', '-c', 'cd /opt/fpp/www && php troubleshootingText.php --manual-crash-report 2>&1');
}

// One command group's part of the Diagnostic Report.
function reportGroup(report: string, grp: string): string {
  const at = report.indexOf(`Command Group: ${grp}\n`);
  if (at < 0) return '';
  const next = report.indexOf('Command Group: ', at + 1);
  return report.slice(at, next < 0 ? undefined : next);
}

test('the Dev Tools tab shows only at the Developer UI level, and a Diagnostic Report still runs it', async ({ page, request }) => {
  // Feature: c943a15d2 (Dev Tools is "level": 3) on 32f8e273e (the page
  // leaves out a group above the UI level).  Without either, the tab showed
  // at every level.
  for (const level of [0, 1, 2]) {
    await setLevel(request, level);
    await openTroubleshooting(page);
    await expect(page.locator('#pills-Networking-tab'), `uiLevel ${level}`).toBeVisible();
    await expect(page.locator('#pills-DevTools-tab, #pills-DevTools'), `uiLevel ${level}`).toHaveCount(0);
  }
  await setLevel(request, 3);
  await openTroubleshooting(page);
  await expect(page.locator('#pills-DevTools-tab')).toHaveText('Dev Tools');

  // The report is not filtered by level: at Basic it still has the group.
  await setLevel(request, 0);
  const dev = reportGroup(diagnosticReport(), 'DevTools');
  expect(dev).toContain('Title  : Available NOCC Helpers');
  expect(dev).toContain('Title  : Developer Settings');
});

test('a command or group above the UI level is left off the page, and shows once the level is raised', async ({ page, request }) => {
  // Feature: 32f8e273e.  troubleshoot-commands.json marks no single command
  // with a level yet, so this player's copy is given one: Networking's
  // Routing at Experimental, and the whole Git group at Advanced.
  const saved = readFile(COMMANDS);
  try {
    const json = JSON.parse(saved);
    json.CommandGroups.Networking.commands.Routing.level = 2;
    json.CommandGroups.Git.level = 1;
    putFile(COMMANDS, JSON.stringify(json, null, 4));

    const routing = (p: Page) => p.locator('#pills-Networking #command_Routing');
    const hotlink = (p: Page) => p.locator('#troubleshooting-hot-links-Networking a[href="#header_Routing"]');

    await setLevel(request, 0);
    await openTroubleshooting(page);
    await expect(page.locator('#pills-Git-tab, #pills-Git')).toHaveCount(0);
    await expect(routing(page)).toHaveCount(0);
    await expect(hotlink(page)).toHaveCount(0);
    // The rest of Networking is still there.
    await expect(page.locator('#pills-Networking #command_Interfaces')).toHaveCount(1);

    await setLevel(request, 1);
    await openTroubleshooting(page);
    await expect(page.locator('#pills-Git-tab')).toBeVisible();
    await expect(routing(page)).toHaveCount(0);

    await setLevel(request, 2);
    await openTroubleshooting(page);
    await expect(routing(page)).toHaveCount(1);
    await expect(hotlink(page)).toHaveText(json.CommandGroups.Networking.commands.Routing.title);

    // A Diagnostic Report at Basic still runs both.
    await setLevel(request, 0);
    const report = diagnosticReport();
    expect(reportGroup(report, 'Networking')).toContain(`Title  : ${json.CommandGroups.Networking.commands.Routing.title}`);
    expect(reportGroup(report, 'Git')).not.toBe('');
  } finally {
    putFile(COMMANDS, saved);
  }
});

test.describe('the Dev Tools commands', () => {
  const NOCC = '/usr/bin/nocc-daemon';
  const TOKEN = 'ghp_fppTestsNotARealToken0123456789';
  const USER = 'fpp-tests-dev-user';
  let restoreSettings: () => void = () => {};

  test.beforeEach(() => {
    restoreSettings = snapshotSettings();
    // The helper runs commands with PATH=/bin:/usr/bin:/sbin:/usr/sbin.  Two
    // helpers: one by address, one by name.
    putFile(NOCC, '#!/bin/sh\n[ "$1" = -print-discovered-servers ] || exit 1\necho 127.0.0.1:43210\necho localhost:43211\n');
    inPlayer('chmod', '755', NOCC);
    setSettingInFile('gitHubUser', USER);
    setSettingInFile('gitHubPAT', TOKEN);
    setSettingInFile('DistributedCompile', '1');
  });

  test.afterEach(() => {
    inPlayer('rm', '-f', NOCC);
    restoreSettings();
  });

  test('list the nocc helpers and the developer settings, never the token', async ({ page, request }) => {
    // Feature: 4f8e60b35 (#3062): Available NOCC Helpers, from nocc-daemon
    // -print-discovered-servers, as IP / port / host name; and Developer
    // Settings, with the GitHub token shown as **** when one is set.  Both
    // name the user or their network ("pii"), so a Diagnostic Report gets
    // their manualCrashReportCmd: a helper count, and no GitHub user name.
    await setLevel(request, 3);
    await openTroubleshooting(page);
    await page.locator('#pills-DevTools-tab').click();
    await expect(page.locator('#pills-DevTools')).toBeVisible();

    const helpers = page.locator('#pills-DevTools #command_NOCCHelpers');
    await expect(helpers).toContainText('HOSTNAME', { timeout: 30_000 });
    const rows = (await helpers.innerText()).split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length === 3);
    expect(rows).toEqual([['IP', 'PORT', 'HOSTNAME'], ['127.0.0.1', '43210', 'localhost'], ['127.0.0.1', '43211', 'localhost']]);

    const settings = page.locator('#pills-DevTools #command_DevSettings');
    await expect(settings).toContainText('GitHub Personal Access Token', { timeout: 30_000 });
    const text = await settings.innerText();
    expect(text).toMatch(/GitHub User Name\s+fpp-tests-dev-user/);
    expect(text).toMatch(/GitHub Personal Access Token\s+\*\*\*\*/);
    expect(text).toMatch(/Distributed Compile\s+1/);
    expect(text).toMatch(/Git Remote Repository\s+origin \(default\)/);
    expect(text).not.toContain(TOKEN);

    const dev = reportGroup(diagnosticReport(), 'DevTools');
    expect(dev).toContain('NOCC helpers discovered: 2');
    expect(dev).not.toContain('127.0.0.1');
    expect(dev).toMatch(/GitHub Personal Access Token\s+\*\*\*\*/);
    expect(dev).not.toContain(TOKEN);
    expect(dev).not.toContain(USER);
  });
});
