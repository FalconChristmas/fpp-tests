import { test, expect } from './fixtures';

// A command argument that may be left blank (fppd marks it allowBlanks, e.g.
// Effect Start's Model: blank means "by start channel") keeps its blank
// choice when the list is refilled from the MultiSync hosts picked for the
// command.  The hosts are addresses no one answers on; the page asks them
// through this player's /proxy/<host>/, which the test answers.

const HOST_A = '192.0.2.21';
const HOST_B = '192.0.2.22';
const NAME = 'fpp-tests-ms-blank';

const offered = (picker) => picker.locator('option').evaluateAll((os) => os.map((o: any) => o.value));

test.describe(() => {
  // run-web.sh publishes the player on a port the UI's CSP doesn't name.
  test.use({ bypassCSP: true });
  test.afterEach(async ({ request }) => {
    await request.delete(`/api/playlist/${NAME}`);
  });

  test('a blank-allowed argument keeps its blank choice when refilled from MultiSync hosts', async ({ page, request }) => {
    // Regression: a7257a1e2 (#2367).  The refill emptied the list and only
    // put a blank back if its first option -- just removed -- was blank, so
    // the Model list of an Effect Start sent to other players lost the
    // blank and an effect could only be run on a model.
    await request.post(`/api/playlist/${NAME}`, { data: { name: NAME, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} } });
    const models = await (await request.get('/api/commands/Effect Start')).json();
    expect(models.args[5], 'fppd marks Effect Start\'s Model as allowing a blank').toMatchObject({ name: 'Model', allowBlanks: true });

    const asked: string[] = [];
    await page.route(/\/proxy\/192\.0\.2\.2[12]\//, (route) => {
      const url = new URL(route.request().url());
      asked.push(url.pathname);
      const host = url.pathname.split('/')[2];
      if (url.pathname.endsWith('/api/models')) return route.fulfill({ json: [`fpp-tests-model-${host}`] });
      return route.fulfill({ json: [] });
    });
    await page.goto('/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    await page.locator('.playlistEntriesAddNewBtn').first().click();
    await page.selectOption('#pe_type', 'command');
    await page.selectOption('#playlistEntryOptions_arg_1', 'Effect Start');
    const picker = page.locator('#playlistEntryCommandOptions_arg_6');
    await expect(picker).toHaveCount(1);
    expect((await offered(picker))[0], 'the local list starts with the blank').toBe('');

    await page.check('#playlistEntryCommandOptions_multisync');
    const custom = page.locator('#playlistEntryCommandOptions_multisyncHostsCustom');
    for (const h of [HOST_A, HOST_B]) {
      await custom.fill(h);
      await custom.press('Enter');
    }
    await expect.poll(() => offered(picker), { message: 'the Model list once refilled from both hosts' })
      .toEqual(expect.arrayContaining([`fpp-tests-model-${HOST_A}`, `fpp-tests-model-${HOST_B}`]));
    expect(asked.some((p) => p.endsWith('/api/models'))).toBe(true);
    const values = await offered(picker);
    expect(values[0], `the refilled list: ${JSON.stringify(values)}`).toBe('');
    expect(values.filter((v) => v === '')).toHaveLength(1);

    // Blank is a choice that saves.  (fppd's side: it declares the blank,
    // checked above; a blank Model runs the effect by start channel.)
    await picker.selectOption('');
    await page.locator('.modal.show button.btn-success', { hasText: /^Add$/ }).click();
    await expect(page.locator('#tblPlaylistMainPlaylist tr.playlistRow')).toHaveCount(1);
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
    await page.getByRole('button', { name: 'Save Playlist' }).click();
    expect((await saved).ok()).toBe(true);
    const entry = (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist[0];
    expect(entry.command).toBe('Effect Start');
    expect(entry.args[5]).toBe('');
    expect(entry.multisyncHosts).toBe(`${HOST_A},${HOST_B}`);
  });
});
