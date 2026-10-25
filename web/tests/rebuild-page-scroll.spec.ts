import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile } from './settings-file';
import { answerUpdateCheck } from './standin-http';

// Regression: 1d0659a26 ("make rebuild page auto scroll with output").  The
// Rebuild FPP page streams a build's output into one long page, and stayed at
// its top: the step being run, and in the end "Rebuild Complete.", were below
// the fold.  It scrolls to the bottom after each step now.
//
// fppd_stop, fpp_build and fppd_start are stood in for by scripts that record
// what they did (the build prints enough to fill several screens), so the
// fppd this suite judges is never touched.

test.skip(!container, 'stands in for the build scripts inside the run-web.sh container');

const SCRIPTS = '/opt/fpp/scripts';
const MARK = '/tmp/fpp-tests-rebuild-scroll';
const FLAG = `${MEDIA}/tmp/fppd_restarted`;

async function withStandIns(fn: () => Promise<void>) {
  const hadFlag = exists(FLAG);
  const standIns: Record<string, string> = {
    [`${SCRIPTS}/fppd_stop`]: `#!/bin/sh\necho stop >> ${MARK}.log\n`,
    [`${SCRIPTS}/fpp_build`]: `#!/bin/sh\necho build >> ${MARK}.log
i=0
while [ $i -lt 300 ]; do echo "fpp-tests build line $i"; i=$((i+1)); done\n`,
    // Long enough to look at the page while it runs.
    [`${SCRIPTS}/fppd_start`]: `#!/bin/sh\necho start >> ${MARK}.log\nsleep 4\n`,
    '/usr/local/bin/systemctl': `#!/bin/sh\necho "systemctl $*" >> ${MARK}.log\n`,
  };
  inPlayer('rm', '-f', `${MARK}.log`);
  for (const [path, script] of Object.entries(standIns)) {
    if (path.startsWith(SCRIPTS)) inPlayer('cp', '-p', path, `${path}.fpp-tests-orig`);
    putFile(path, script);
    inPlayer('chmod', '+x', path);
  }
  try {
    await fn();
  } finally {
    for (const path of Object.keys(standIns)) {
      if (path.startsWith(SCRIPTS)) inPlayer('mv', '-f', `${path}.fpp-tests-orig`, path);
      else inPlayer('rm', '-f', path);
    }
    inPlayer('rm', '-f', `${MARK}.log`);
    if (!hadFlag) inPlayer('rm', '-f', FLAG);
  }
}

// Scrolled to (within a few lines of) the bottom: the page scrolls after each
// step, and the step's banner lines land below that.  It has no doctype
// (quirks mode), so the body may be what scrolls.
const atBottom = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const s = document.scrollingElement!;
  return s.scrollTop + s.clientHeight >= s.scrollHeight - 100;
});

test('the Rebuild FPP page follows its output to the bottom', async ({ page }) => {
  test.setTimeout(120_000);
  await withStandIns(async () => {
    const done = page.waitForResponse((r) => new URL(r.url()).pathname === '/rebuildfpp.php', { timeout: 60_000 });
    // Opened by POST from an FPP page, as its Rebuild button does (PostNavigate).
    await answerUpdateCheck(page);
    await page.goto('/index.php');
    await page.waitForFunction(() => typeof (window as any).PostNavigate === 'function');
    await page.evaluate(() => (window as any).PostNavigate('rebuildfpp.php'));
    // While fppd is being started again, after the build's output is in.
    await expect.poll(() => exists(`${MARK}.log`) && inPlayer('cat', `${MARK}.log`).includes('start'), { timeout: 30_000 }).toBe(true);
    await expect(page.locator('pre')).toContainText('fpp-tests build line 299');
    // The control: the output is taller than the window.
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight > window.innerHeight * 2)).toBe(true);
    await expect.poll(() => atBottom(page), { timeout: 5_000, message: 'the page did not follow the build output' }).toBe(true);
    await (await done).finished();
    await expect(page.locator('body')).toContainText('Rebuild Complete.');
    await expect.poll(() => atBottom(page), { timeout: 5_000, message: 'the page did not end at the bottom' }).toBe(true);
  });
});

test('a Rebuild FPP asked for by curl gets the output and no page script', async () => {
  // Regression: like a1ddad2da's changebranch.php, the per-step scrolls go to
  // a browser only, but the links and the scroll after "Rebuild Complete."
  // went to curl too.  By POST, as the deprecated GET is not.
  test.setTimeout(120_000);
  await withStandIns(async () => {
    const body = inPlayer('curl', '-s', '--max-time', '90', '-X', 'POST', '-d', '', 'http://127.0.0.1/rebuildfpp.php');
    // The control: the rebuild ran to its end.
    expect(body).toContain('fpp-tests build line 299');
    expect(body).toContain('Rebuild Complete.');
    expect(inPlayer('cat', `${MARK}.log`)).toContain('start');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('Go to FPP Main Status Page');
  });
});
