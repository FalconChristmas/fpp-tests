import { test, expect } from './fixtures';

// The release notes dialog's Upgrade button calls UpgradeFPPVersion() with
// the release's version, which the GitHub API gives without a "v" ("10.1")
// and git names with one ("v10.1").

test('the version upgrade asks for the git ref once prefixed, either way it is given', async ({ page }) => {
  // Regression: 2f0a7fdf5.  ViewReleaseNotes() added the "v" and
  // UpgradeFPPVersion() added another: upgradefpp.php was asked for
  // "vv10.1", which upgrade_FPP could not check out.
  await page.goto('/index.php');
  const urlFor = (version: string) => page.evaluate((v) => {
    const w = window as any;
    let url = '';
    // Capture the request instead of starting an upgrade of the served tree.
    w.confirm = () => true;
    for (const f of ['DoModalDialog', 'CloseModalDialog', 'FPPUpdate_MarkStarted', 'FPPUpdate_AddHideButton']) {
      w[f] = () => {};
    }
    w.UpdateActivityBusySide = () => '';
    w.StreamURL = (u: string) => { url = u; };
    w.UpgradeFPPVersion(v);
    return url;
  }, version);
  expect(await urlFor('10.1')).toBe('upgradefpp.php?version=v10.1');
  expect(await urlFor('v10.1')).toBe('upgradefpp.php?version=v10.1');
});
