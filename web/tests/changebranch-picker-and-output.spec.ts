import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The Developer settings' Git Branch picker and the Change Branch page it
// opens (changebranch.php, which streams scripts/git_branch's output).  The
// branches come from a git repository put at /opt/fpp for the test (the
// served tree is an export, with none); git_branch is stood in for, so the
// player's tree is never changed.

test.skip(!container, 'puts a git repository and a git_branch stand-in in the run-web.sh container');

test.afterEach(() => {
  inPlayer('rm', '-rf', '/opt/fpp/.git');
});

function gitRepo() {
  inPlayer('sh', '-c', 'cd /opt/fpp && git init -q && c=$(git -c user.name=fpp-tests -c user.email=fpp-tests@invalid ' +
    'commit-tree $(git mktree < /dev/null) -m fpp-tests) && git update-ref refs/remotes/origin/aaa-fpp-tests-first $c && ' +
    'git update-ref refs/remotes/origin/master $c');
}

test('the branches listed for a remote start with nothing chosen, so the first can be picked', async ({ page }) => {
  // Regression: fd081d31a.  The list filled in for the remote picked above
  // it had the current branch, or with none matching the first branch,
  // already selected, so picking that branch was no change: the select
  // fired no change event and the switch was never asked for.  It now
  // starts on a "-- Select Branch --" entry.
  gitRepo();
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '3');
    setSettingInFile('gitRemote', 'origin');
    await page.route('**/api/settings/gitRemote', (route) =>
      route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
    await page.goto('/settings.php#settings-developer');
    const picker = page.locator('#gitBranch');
    await expect(page.locator('#gitRemote')).toHaveValue('origin', { timeout: 30_000 });
    // The user picks the remote: its branches are listed afresh.
    const listed = page.waitForResponse((r) => r.url().includes('/api/git/branches'), { timeout: 60_000 });
    await page.selectOption('#gitRemote', 'origin');
    await listed;
    // The control: the branches are listed.
    await expect(picker.locator('option[value="aaa-fpp-tests-first"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(picker.locator('option[value="master"]')).toHaveCount(1);
    // Nothing chosen yet, so whichever branch the user picks -- the first
    // listed included -- is a change.
    await expect(picker).toHaveValue('');
    expect(await picker.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex].textContent)).toContain('Select Branch');
  });
});

test('the branches the page opens with start with nothing chosen when the current branch is not among them', async ({ page }) => {
  // Regression: f8738cfee.  fd081d31a put the "-- Select Branch --" entry
  // only in the list the page fills in when a remote is picked.  The list
  // the page opens with, printed by PrintGitBranchOptions(), had none and
  // selected only the current branch; with that branch not on the remote (a
  // local or pr-N branch, a detached HEAD) the browser showed the first,
  // which then couldn't be picked.
  gitRepo();
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '3');
    setSettingInFile('gitRemote', 'origin');
    await page.goto('/settings.php#settings-developer');
    const picker = page.locator('#gitBranch');
    await expect(picker.locator('option[value="aaa-fpp-tests-first"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(picker).toHaveValue('', { timeout: 2_000 });
  });
});

test("the Change Branch page follows git_branch's output to the bottom as it comes", async ({ page }) => {
  // Regression: fd081d31a.  changebranch.php ran git_branch with system()
  // and the page stayed at its top: the switch's progress, and how it ended,
  // were below the fold.  It now streams the output and scrolls after each
  // line.  (small-endpoints.spec.ts checks a script or remote caller gets
  // no page script in it, a1ddad2da.)
  test.setTimeout(120_000);
  const SCRIPT = '/opt/fpp/scripts/git_branch';
  inPlayer('cp', '-p', SCRIPT, `${SCRIPT}.fpp-tests-orig`);
  // A switch that prints several screens, then holds before its last line.
  putFile(SCRIPT, '#!/bin/sh\ni=0\nwhile [ $i -lt 200 ]; do echo "fpp-tests git_branch line $i"; i=$((i+1)); done\n' +
    'sleep 4\necho "fpp-tests git_branch done"\n');
  inPlayer('chmod', '755', SCRIPT);
  const atBottom = () => page.evaluate(() => {
    const s = document.scrollingElement!;
    return s.scrollTop + s.clientHeight >= s.scrollHeight - 100;
  });
  try {
    const done = page.waitForResponse((r) => new URL(r.url()).pathname === '/changebranch.php', { timeout: 60_000 });
    await page.goto('/index.php');
    await page.waitForFunction(() => typeof (window as any).PostNavigate === 'function');
    // As the Developer tab's ChangeGitBranch opens it.
    await page.evaluate(() => (window as any).PostNavigate('changebranch.php?branch=master&remote=origin'));
    // While git_branch holds before its last line.
    await expect(page.locator('#output')).toContainText('fpp-tests git_branch line 199', { timeout: 30_000 });
    expect(await page.locator('#output').textContent()).not.toContain('fpp-tests git_branch done');
    // The control: the output is taller than the window.
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight > window.innerHeight * 2)).toBe(true);
    await expect.poll(atBottom, { timeout: 5_000, message: 'the page did not follow the output' }).toBe(true);
    await (await done).finished();
    await expect(page.locator('#output')).toContainText('fpp-tests git_branch done');
    await expect.poll(atBottom, { timeout: 5_000, message: 'the page did not end at the bottom' }).toBe(true);
  } finally {
    inPlayer('mv', '-f', `${SCRIPT}.fpp-tests-orig`, SCRIPT);
  }
});
