import { test, expect } from './fixtures';
import { container } from './container';
import { putFile, readFile } from './settings-file';

// The Troubleshooting page's on-screen treatment of a command's output: the
// text is shown as it is, and the [PASS]/[WARN]/[FAIL] lines in it are
// counted into badges beside the heading, the hot link and the group's tab.
// The commands here are stand-ins in this player's copy of
// troubleshoot-commands.json that print the lines under test.

test.skip(!container, 'changes troubleshoot-commands.json inside the run-web.sh container');

const COMMANDS = '/opt/fpp/www/troubleshoot-commands.json';

test('failures and warnings are badged on the heading, the hot link and the tab, and angle brackets survive', async ({ page }) => {
  // Feature: 1d261fe25.  Output was assigned to innerHTML, so anything a tool
  // printed in angle brackets (a <unavailable> value) was taken for a tag and
  // vanished; and the verdicts in it were left for the reader to find.
  const saved = readFile(COMMANDS);
  try {
    const json = JSON.parse(saved);
    const cmds = json.CommandGroups.Networking.commands;
    // The helper wraps a command in sh -c '...', so no single quotes in it.
    cmds.Interfaces.cmd = 'printf "[PASS] link up\\n[FAIL] no route\\n    check the cable\\n[WARN] slow\\n[WARN] noisy\\nspeed: <unavailable>\\n"';
    cmds.Routing.cmd = 'printf "[PASS] one\\n[PASS] two\\n"';
    putFile(COMMANDS, JSON.stringify(json, null, 4));

    await page.goto('/troubleshooting.php');
    const out = page.locator('#command_Interfaces');
    await expect(out).toContainText('check the cable', { timeout: 30_000 });
    await expect(page.locator('#command_Routing')).toContainText('[PASS] two');

    // The text is not parsed as markup.
    await expect(out).toContainText('speed: <unavailable>');
    // The verdict lines are marked by kind.
    await expect(out.locator('span.bg-danger-subtle')).toHaveText('[FAIL] no route');
    await expect(out.locator('span.bg-warning-subtle')).toHaveCount(2);

    // The counts, beside the heading, in the hot link and on the tab.
    await expect(page.locator('#status_Interfaces .badge.text-bg-danger')).toHaveText('1 failure');
    await expect(page.locator('#status_Interfaces .badge.text-bg-warning')).toHaveText('2 warnings');
    await expect(page.locator('#hotlinkstatus_Interfaces .badge.text-bg-danger')).toHaveText('1');
    await expect(page.locator('#status_Routing .badge.text-bg-success')).toHaveText('2 passed');
    await expect(page.locator('#tabstatus-Networking .badge.text-bg-danger')).toHaveText('1');
    await expect(page.locator('#tabstatus-Networking .badge.text-bg-warning')).toHaveText('2');
  } finally {
    putFile(COMMANDS, saved);
  }
});
