import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings, settingInFile } from './settings-file';

const MEDIA = '/home/fpp/media';

test.describe('the status page statistics banner', () => {
  test.skip(!container, 'changes the player settings');

  test('shows while statsPublish is "Banner", and Enable Stats sets it to "Enabled"', async ({ page }) => {
    // 0c871134e (the banner), 49ee16e42 (its Enable button), 2486f2841 (the
    // value's spelling), 7bbfabdef (the banner reads the page's own settings).
    const restore = snapshotSettings();
    try {
      setSettingInFile('statsPublish', 'Banner');
      await page.goto('/index.php');
      await expect(page.locator('#bannerRow')).toContainText('anonymous statistics');
      await page.locator('#bannerRow button', { hasText: 'Enable Stats' }).click();
      await expect(page.locator('#bannerRow')).toBeHidden();
      await expect.poll(() => settingInFile('statsPublish'), { timeout: 10_000 }).toBe('Enabled');
    } finally {
      restore();
    }
  });

  test('is not shown once statsPublish is anything but "Banner"', async ({ page }) => {
    // 7bbfabdef
    const restore = snapshotSettings();
    try {
      for (const v of ['Enabled', 'Disabled']) {
        setSettingInFile('statsPublish', v);
        await page.goto('/index.php');
        await expect(page.locator('#bannerRow')).toBeHidden();
      }
    } finally {
      restore();
    }
  });
});

test.describe('API answers about files', () => {
  test.skip(!container, 'seeds files inside the run-web.sh container');

  test('the effects list comes back sorted', async ({ request }) => {
    // 20a81f1e6
    const names = ['fpp-tests-z', 'fpp-tests-a', 'fpp-tests-m'];
    try {
      for (const n of names) inPlayer('sh', '-c', `printf ESEQ > ${MEDIA}/effects/${n}.eseq`);
      const got: string[] = (await (await request.get('/api/effects')).json()).filter((n: string) => n.startsWith('fpp-tests-'));
      expect(got).toEqual(['fpp-tests-a', 'fpp-tests-m', 'fpp-tests-z']);
    } finally {
      inPlayer('rm', '-f', ...names.map((n) => `${MEDIA}/effects/${n}.eseq`));
    }
  });

  test('a sequence fsequtils cannot read gets placeholder metadata, not "Not Found"', async ({ request }) => {
    // 3c8174903 (placeholder metadata), 68ab9d0f8 (fsequtils' stderr stays out of the JSON).
    try {
      inPlayer('sh', '-c', `printf junk > ${MEDIA}/sequences/fpp-tests-bad.fseq`);
      const r = await request.get('/api/sequence/fpp-tests-bad.fseq/meta');
      expect(r.status()).toBe(200);
      const m = await r.json();
      expect(m.Name).toBe('fpp-tests-bad.fseq');
      expect(m.Version).toBe('?.?');
      expect(m.StepTime).toBe(-1);
    } finally {
      inPlayer('rm', '-f', `${MEDIA}/sequences/fpp-tests-bad.fseq`);
    }
  });
});
