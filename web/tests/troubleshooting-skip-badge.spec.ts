import { test, expect } from './fixtures';
import { container } from './container';
import { putFile, readFile } from './settings-file';

// The Troubleshooting page's verdict badges for a command whose checks all
// skipped.  A section with nothing that applies to the device (Network Audio on
// a simple-mode player with no AES67, Opus or RTSP set up skips all three)
// prints only [SKIP] lines.  The commands here are stand-ins in this player's
// copy of troubleshoot-commands.json that print the verdict lines under test.

test.skip(!container, 'changes troubleshoot-commands.json inside the run-web.sh container');

const COMMANDS = '/opt/fpp/www/troubleshoot-commands.json';

test('a command that only skipped says "nothing to check", and a skip beside a pass changes nothing', async ({ page }) => {
  // Regression: 795efc47a.  The page counted PASS, WARN and FAIL only, so a
  // command whose every check skipped got no badge at all and read as though
  // it had not run; its group's tab was blank for the same reason.
  const saved = readFile(COMMANDS);
  try {
    const json = JSON.parse(saved);
    const cmds = json.CommandGroups.Networking.commands;
    // The helper wraps a command in sh -c '...', so no single quotes in it.
    cmds.Interfaces.cmd = 'printf "[SKIP] AES67 is not configured\\n[SKIP] Opus RTP is not configured\\n"';
    cmds.Routing.cmd = 'printf "[SKIP] one\\n[PASS] two\\n"';
    putFile(COMMANDS, JSON.stringify(json, null, 4));

    await page.goto('/troubleshooting.php');
    await expect(page.locator('#command_Interfaces')).toContainText('Opus RTP is not configured', { timeout: 30_000 });
    await expect(page.locator('#command_Routing')).toContainText('[PASS] two');

    // Only skips: a grey badge beside the heading, a dash in the hot link.
    await expect(page.locator('#status_Interfaces .badge')).toHaveText('nothing to check');
    await expect(page.locator('#status_Interfaces .badge')).toHaveClass(/text-bg-secondary/);
    await expect(page.locator('#hotlinkstatus_Interfaces .badge')).toHaveText('-');
    // The counts the page keeps for the tab include the skips.
    await expect(page.locator('#command_Interfaces')).toHaveAttribute('data-troubleshoot-skip', '2');

    // A pass beside a skip is a pass: "1 passed" and no "nothing to check".
    await expect(page.locator('#status_Routing .badge')).toHaveText('1 passed');
    await expect(page.locator('#status_Routing')).not.toContainText('nothing to check');
  } finally {
    putFile(COMMANDS, saved);
  }
});
