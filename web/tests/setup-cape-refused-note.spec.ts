import { test, expect } from './fixtures';
import { container } from './container';
import { dropSettings, keepingSettings } from './privacy-helpers';

// The setup wizard re-asks the cape (api/cape/defaults) once the jurisdiction
// is chosen, and explains on the privacy step any default the cape suggested
// that was refused.  The setup project has finished the wizard before this
// runs; the test opens it again with the answers taken out of the settings
// file and never Finishes.  The cape's answer is a stub.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const ANSWERS = ['LegalJurisdiction', 'statsPublish', 'ShareCrashData', 'FetchVendorLogos', 'SendVendorSerial', 'privacyConsent'];
const OPT_IN = 'this jurisdiction requires prior opt-in before a device may transmit';
const OTHER = 'the cape marked it read-only';

test('refused cape defaults are explained once per reason, not once per setting', async ({ page }) => {
  // Regression: b51e9f425.  The note listed every refused setting against the
  // reason belonging to the first of them, so with two reasons in play it
  // stated a reason that did not apply to most of the list.
  await page.route((u) => u.pathname.endsWith('/api/cape/defaults'), (route) => route.fulfill({ json: {
    jurisdiction: 'EU', priorOptIn: true, settings: {},
    refused: { statsPublish: OPT_IN, ShareCrashData: OPT_IN, SendVendorSerial: OPT_IN, FetchVendorLogos: OTHER },
  } }));
  await keepingSettings(async () => {
    dropSettings(...ANSWERS);
    await page.goto('/initialSetup.php');
    await page.selectOption('#LegalJurisdiction', 'EU');
    for (const step of [2, 3]) {
      await page.click('#setupNextBtn');
      await expect(page.locator(`.setupStep[data-step="${step}"]`)).toBeVisible({ timeout: 60_000 });
    }
    const note = page.locator('#capeRefusedNote');
    await expect(note).toBeVisible();
    // One sentence per reason: the three that share one are named together,
    // the fourth with its own.
    const sentences = note.locator('b');
    await expect(sentences).toHaveCount(2);
    await expect(sentences.nth(0)).toHaveText('statsPublish, ShareCrashData and SendVendorSerial');
    await expect(sentences.nth(1)).toHaveText('FetchVendorLogos');
    const text = (await note.innerText()).replace(/\s+/g, ' ');
    expect(text).toContain(`statsPublish, ShareCrashData and SendVendorSerial were not applied because ${OPT_IN}.`);
    expect(text).toContain(`FetchVendorLogos was not applied because ${OTHER}.`);
    expect(text.match(/not applied because/g)).toHaveLength(2);
  });
});
