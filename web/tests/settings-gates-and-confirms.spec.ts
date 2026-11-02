import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingFile, keepingSettings, setSettingInFile } from './privacy-helpers';

// Small page behaviours: the SSH Keys box is an Advanced-level option, the
// Developer tab's branch picker asks before switching, and a select built
// around a value that is not among its options still shows that value.

test.skip(!container, 'puts markers, a git repository and settings in the run-web.sh container');

test('the SSH Keys box on Settings > System is shown from the Advanced level up', async ({ page }) => {
  // Regression: 4811b69a8.  The box that edits root's and fpp's
  // authorized_keys (with its Save Keys button) was printed at every UI
  // level; a Basic-level user was offered it.  It is now inside a
  // $uiLevel >= 1 check.  The OS security section is only printed on a real
  // player (platform marker present, container marker absent), so the
  // container's markers are changed for the page load.
  test.setTimeout(120_000);
  await keepingFile('/etc/fpp/container', () => keepingFile('/etc/fpp/platform', () => keepingSettings(async () => {
    inPlayer('rm', '-f', '/etc/fpp/container');
    inPlayer('sh', '-c', "mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > /etc/fpp/platform");
    const load = async (level: string) => {
      setSettingInFile('uiLevel', level);
      await page.goto(`/settings.php?tab=System&lvl=${level}`);
      await page.click('#settings-system-tab');
      // The control: the section the box lives in is on the page.
      await expect(page.locator('#osPasswordEnable')).toBeVisible({ timeout: 30_000 });
    };
    await load('0');
    await expect(page.locator('#sshKeys')).toHaveCount(0);
    await expect(page.locator('input[value="Save Keys"]')).toHaveCount(0);
    await load('1');
    await expect(page.locator('#sshKeys')).toBeVisible();
    await expect(page.locator('input[value="Save Keys"]')).toBeVisible();
  })));
});

function gitRepo() {
  inPlayer('sh', '-c', 'cd /opt/fpp && git init -q && c=$(git -c user.name=fpp-tests -c user.email=fpp-tests@invalid ' +
    'commit-tree $(git mktree < /dev/null) -m fpp-tests) && git update-ref refs/remotes/origin/aaa-fpp-tests-first $c && ' +
    'git update-ref refs/remotes/origin/master $c');
}

test('choosing a branch on the Developer tab asks first: Cancel stays put, OK opens the switch', async ({ page }) => {
  // Regression: e14d8163d.  Picking a branch in the Git Branch select went
  // straight to changebranch.php, so a slip of the mouse started a switch of
  // the player's tree.  ChangeGitBranch() now confirms, and on Cancel
  // reloads the page so the select shows the current branch again.
  test.setTimeout(120_000);
  gitRepo();
  try {
    await keepingSettings(async () => {
      setSettingInFile('uiLevel', '3');
      setSettingInFile('gitRemote', 'origin');
      const switches: string[] = [];
      // The switch itself is answered here: git_branch never runs.
      await page.route('**/changebranch.php*', (route) => {
        switches.push(route.request().url());
        route.fulfill({ contentType: 'text/html', body: '<html><body id="fpp-tests-switch">switching</body></html>' });
      });
      await page.goto('/settings.php#settings-developer');
      const picker = page.locator('#gitBranch');
      await expect(picker.locator('option[value="aaa-fpp-tests-first"]')).toHaveCount(1, { timeout: 30_000 });

      // Cancel: asked once, naming the branch; no switch; the page reloads.
      const asked: string[] = [];
      page.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
      await page.evaluate(() => { (window as any).fppTestsMarker = 1; });
      await picker.selectOption('aaa-fpp-tests-first');
      await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);
      expect(asked[0]).toContain("switch to the 'aaa-fpp-tests-first' branch");
      await expect.poll(() => page.evaluate(() => (window as any).fppTestsMarker ?? 0).catch(() => -1),
        { timeout: 30_000, message: 'the page did not reload after Cancel' }).toBe(0);
      expect(switches, 'a switch was asked for after Cancel').toEqual([]);

      // OK: the switch is asked for, with the branch.
      await expect(picker.locator('option[value="aaa-fpp-tests-first"]')).toHaveCount(1, { timeout: 30_000 });
      page.once('dialog', (d) => d.accept());
      await picker.selectOption('aaa-fpp-tests-first');
      await expect.poll(() => switches.length, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(switches[0]).toContain('branch=aaa-fpp-tests-first');
    });
  } finally {
    inPlayer('rm', '-rf', '/opt/fpp/.git');
  }
});

test('a select built around a value not among its options shows that value', async ({ page }) => {
  // Regression: b7ce4b014.  CreateSelect() added an option for a current
  // value that is not in the list, but without "selected": the browser then
  // showed the first option, and saving the page silently changed the value.
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).CreateSelect === 'function');
  const r = await page.evaluate(() => {
    const html = (window as any).CreateSelect({ a: 'A', b: 'B' }, 'zzz', 'Pick', 'None', 'fpptests-sel');
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const sel = host.querySelector('select') as HTMLSelectElement;
    const known = (window as any).CreateSelect({ a: 'A', b: 'B' }, 'b', 'Pick', 'None', 'fpptests-sel');
    const host2 = document.createElement('div');
    host2.innerHTML = known;
    return { value: sel.value, options: Array.from(sel.options).map((o) => o.value), known: (host2.querySelector('select') as HTMLSelectElement).value };
  });
  // The control: a value in the list is the one chosen.
  expect(r.known).toBe('b');
  expect(r.options).toContain('zzz');
  expect(r.value).toBe('zzz');
});
