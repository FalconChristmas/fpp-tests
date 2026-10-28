import { test, expect } from '@playwright/test';

// A tree with no .git (git archive, a downloaded ZIP, the tree this suite
// serves) takes its version from src/EXPORTED_VERSION. fppversion.sh derived
// the major and minor numbers before reading that file, from "Unknown", so the
// generated getFPPVersionFloat() returned the bare Unknown.Unknown, an undefined
// constant to PHP, and config.php's call to it made every page a 500. Fixed in
// fpp 1bd26fcf2 ("fix(build): version numbers of an exported tree came out as
// Unknown"). fixups/1bd26fcf2-exported-version.patch backports the fix to the
// older trees this suite builds, so it goes red only with that fixup removed.

test('An exported tree serves its pages', async ({ request }) => {
  for (const page of ['/index.php', '/settings.php', '/playlists.php']) {
    const r = await request.get(page);
    expect(r.status(), `${page} answered ${r.status()}`).toBe(200);
    // The fatal error came after the headers had gone out, so the status was
    // still 200: the page stopped at "var FPP_VERSION_FLOAT =" instead.
    const body = await r.text();
    expect(body, `${page} has a version number`).toMatch(/var FPP_VERSION_FLOAT = [0-9.]+;/);
    expect(body, `${page} ends`).toContain('</html>');
  }
});
