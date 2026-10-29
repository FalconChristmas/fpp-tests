import { test, expect } from './fixtures';

// A command sent to other players by MultiSync takes its argument lists from
// those players: with two hosts picked, each list holds what either has, each
// entry marked with how many of them have it.  The hosts here are two
// addresses no one answers on; the page asks them through this player's
// /proxy/<host>/, which the test answers.

const HOST_A = '192.0.2.11';
const HOST_B = '192.0.2.12';

const offered = (picker) => picker.locator('option').evaluateAll((os) => os.map((o: any) => o.value).sort());

test.describe(() => {
  // run-web.sh publishes the player on a port the UI's CSP doesn't name.
  test.use({ bypassCSP: true });
  test('a command entry for two MultiSync hosts lists what each of them has', async ({ page, request }) => {
    // Regression: 5b19c77be.  When the hosts field became checkboxes, the
    // reload took only the first picked host, so a list showed only what
    // that one player had.  Also covers 9fae42ac3, which first filled the
    // lists from every picked host and counted them ("exists on 1/2 Hosts");
    // with the reload limited to a single host again, only the first host's
    // entry is listed.  And cef4858c5, which sent those requests through
    // /proxy/<host>/ rather than straight to each host, so that connect-src
    // need not name every remote (csp-generator.spec.ts checks the policy
    // half): fetched from the hosts directly, no list gets anything.
    const name = 'fpp-tests-ms-hosts';
    await request.post(`/api/playlist/${name}`, { data: { name, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} } });
    const asked: string[] = [];
    await page.route(/\/proxy\/192\.0\.2\.1[12]\//, (route) => {
      const host = new URL(route.request().url()).pathname.split('/')[2];
      asked.push(host);
      return route.fulfill({ json: [`fpp-tests-on-${host}`] });
    });
    try {
      await page.goto('/playlists.php');
      await page.locator('.playlistCard h3', { hasText: new RegExp(`^${name}$`) }).click();
      await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
      await page.locator('.playlistEntriesAddNewBtn').first().click();
      await page.selectOption('#pe_type', 'command');
      await page.selectOption('#playlistEntryOptions_arg_1', 'Start Playlist');
      const picker = page.locator('#playlistEntryCommandOptions_arg_1');
      await expect(picker).toHaveCount(1);
      await page.check('#playlistEntryCommandOptions_multisync');
      const custom = page.locator('#playlistEntryCommandOptions_multisyncHostsCustom');
      for (const h of [HOST_A, HOST_B]) {
        await custom.fill(h);
        await custom.press('Enter');
      }
      await expect.poll(() => offered(picker), { message: 'the playlist picker after both hosts are picked' })
        .toEqual(expect.arrayContaining([`fpp-tests-on-${HOST_A}`, `fpp-tests-on-${HOST_B}`]));
      expect(new Set(asked)).toEqual(new Set([HOST_A, HOST_B]));
      await expect(picker.locator(`option[value="fpp-tests-on-${HOST_B}"]`)).toHaveText(/exists on 1\/2 Hosts/);
    } finally {
      await request.delete(`/api/playlist/${name}`);
    }
  });
});
