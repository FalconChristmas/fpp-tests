import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { dropSettings, keepingSettings } from './privacy-helpers';

// The setup wizard's privacy step, where the jurisdiction needs prior opt-in
// and so the step will not move on until every row is answered: once Next has
// been refused the rows still to answer are marked, the marks clear one by one
// as they are answered, and clearing the last takes the note with it.  The
// setup project has finished the wizard before this runs; the test opens it
// again with the answers taken out of the settings file, and never Finishes.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const CAPEDETECT = '/opt/fpp/src/fppcapedetect';
const ANSWERS = ['LegalJurisdiction', 'statsPublish', 'ShareCrashData', 'FetchVendorLogos', 'SendVendorSerial', 'privacyConsent'];

// Leaving step 1 asks cape detection for its defaults, which waits for an I2C
// bus the container lacks; without it the wizard decides from the jurisdiction.
async function withoutCapeDetect<T>(fn: () => Promise<T>): Promise<T> {
  inPlayer('mv', CAPEDETECT, `${CAPEDETECT}.fpp-tests`);
  try {
    return await fn();
  } finally {
    inPlayer('mv', `${CAPEDETECT}.fpp-tests`, CAPEDETECT);
  }
}

async function toPrivacyStep(page: Page, jurisdiction: string) {
  await page.goto('/initialSetup.php');
  await page.selectOption('#LegalJurisdiction', jurisdiction);
  for (const step of [2, 3]) {
    await page.click('#setupNextBtn');
    await expect(page.locator(`.setupStep[data-step="${step}"]`)).toBeVisible({ timeout: 60_000 });
  }
}

const marked = (page: Page) => page.locator('#privacyTable tr.privacyUnanswered');

test('the rows still to answer are marked once Next is refused, and the marks and the note clear as they are answered', async ({ page }) => {
  // Regression: db23b8973.  The note said "answer each of these" over a table
  // of eight rows and left it to the user to find which; the rows still to
  // answer are now marked from the first refusal, and answering one clears its
  // mark (the last, the note too).
  await keepingSettings(() => withoutCapeDetect(async () => {
    dropSettings(...ANSWERS);
    await toPrivacyStep(page, 'EU');
    await expect(marked(page), 'nothing is marked before Next has been refused').toHaveCount(0);

    await page.click('#setupNextBtn');
    await expect(page.locator('#privacyRequiredNote')).toBeVisible();
    await expect(page.locator('.setupStep[data-step="3"]')).toBeVisible();
    await expect(marked(page).first(), 'the refusal marks the unanswered rows').toBeVisible();
    const rows = await marked(page).evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).dataset.row!));
    expect(rows, 'the statistics row is one of them').toContain('stats');
    for (const row of rows) {
      const answer = await page.evaluate((r) => (window as any).fppPrivacyTable.get(r), row);
      expect(answer, `${row} is marked, so it has no answer`).toBe('');
    }

    // Answering one row clears that row's mark and no other, and the note stays.
    await page.locator('input[name="privacy_stats"][value="deny"]').check();
    await expect(page.locator('#privacyTable tr[data-row="stats"]')).not.toHaveClass(/privacyUnanswered/);
    await expect(marked(page)).toHaveCount(rows.length - 1);
    await expect(page.locator('#privacyRequiredNote')).toBeVisible();

    // Answer what is left, always the first marked row (answering one can
    // reveal or release another); the last answer takes the note away.
    for (let i = 0; i < 12 && (await marked(page).count()) > 0; i++) {
      const row = await marked(page).first().evaluate((tr) => (tr as HTMLElement).dataset.row!);
      await page.locator(`input[name="privacy_${row}"][value="deny"]`).check();
    }
    await expect(marked(page)).toHaveCount(0);
    await expect(page.locator('#privacyRequiredNote'), 'the last answer takes the note with it').toBeHidden();
  }));
});
