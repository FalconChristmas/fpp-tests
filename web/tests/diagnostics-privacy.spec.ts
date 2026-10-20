import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, keepingFile, keepingSettings, setSettingInFile, writeFile } from './privacy-helpers';

// Crash reports kept on the player, the Diagnostic Report built on request,
// and the other diagnostics pages: what they send, and to whom.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const CRASHES = `${MEDIA}/crashes`;
const HOSTS = '/etc/hosts';

// The zip's member names, and one member's text, read inside the player.
function zipNames(path: string): string[] {
  return JSON.parse(inPlayer('python3', '-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', path));
}
function zipMember(path: string, name: string): string {
  return inPlayer('python3', '-c', 'import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("latin-1"))', path, name);
}

test.describe('locally kept crash reports', () => {
  const NAME = 'fpp-Docker-10.x-fpp-tests-uuid-2026-01-01_00-00-00.zip';

  test.beforeEach(() => {
    inPlayer('sh', '-c', `mkdir -p ${CRASHES} && printf 'PK\\005\\006%018d' 0 > ${CRASHES}/${NAME}`);
  });
  test.afterEach(() => {
    inPlayer('sh', '-c', `rm -f ${CRASHES}/${NAME} ${CRASHES}/*-fpp-tests-manual.zip`);
  });

  test('an upload that cannot be confirmed keeps the report', async ({ request }) => {
    // Feature: 6568f3838.  The player posts a kept report itself; when it
    // cannot reach the server it says so (CanRetryFromBrowser) and the report
    // stays -- it is deleted only after a confirmed upload, by the caller.
    // The upload host is pointed at this player's own closed port 443, so
    // nothing leaves it.
    await keepingFile(HOSTS, async () => {
      inPlayer('sh', '-c', `echo '127.0.0.1 crashes.falconplayer.com' >> ${HOSTS}`);
      const r = await (await request.post(`/api/crashes/upload/${NAME}`)).json();
      expect(r.Status).toBe('Error');
      expect(r.CanRetryFromBrowser, JSON.stringify(r)).toBe(true);
      expect(inPlayer('ls', CRASHES)).toContain(NAME);
    });
    const target = await (await request.get('/api/crashes/uploadTarget')).json();
    expect(target).toMatchObject({ Status: 'OK', url: 'https://crashes.falconplayer.com/crashUpload/index.php', field: 'userfile' });
  });

  test('only a crash report in crashes/ can be sent', async ({ request }) => {
    // 6568f3838: the name is reduced to a basename and must look like one of
    // fppd's reports, or this would upload any file on the player.
    // Feature: 584744bc1 -- a missing report answers Code not-found.
    for (const name of ['settings', 'fpp-tests.txt', 'backup.zip']) {
      const r = await (await request.post(`/api/crashes/upload/${name}`)).json();
      expect(r, name).toMatchObject({ Status: 'Error', Message: 'Not a crash report file name' });
    }
    const missing = await (await request.post('/api/crashes/upload/fpp-Docker-10.x-gone-2026-01-01_00-00-00.zip')).json();
    expect(missing).toMatchObject({ Status: 'Error', Code: 'not-found' });
  });

  test('a report built on request is sent only with the user\'s consent', async ({ request }) => {
    // 1a88db3bc: a -manual report needs {"consent": true}, the answer to the
    // dialog that shows what it holds.
    const manual = 'fpp-Docker-10.x-uuid-2026-01-01_00-00-00-fpp-tests-manual.zip';
    inPlayer('sh', '-c', `cp ${CRASHES}/${NAME} ${CRASHES}/${manual}`);
    for (const data of [undefined, { consent: 1 }, { consent: 'true' }]) {
      const r = await (await request.post(`/api/crashes/upload/${manual}`, data ? { data } : {})).json();
      expect(r.Code, JSON.stringify(data)).toBe('consent-required');
    }
  });
});

test('the crash disclosures are the privacy table\'s, and name the e-mail address only when there is one', async ({ request }) => {
  // Feature: b6b8a9c6e.  The send dialog shows the crash rows of Settings >
  // Privacy, served by GET /api/crashes/disclosures, so the two cannot drift.
  await keepingSettings(async () => {
    setSettingInFile('emailAddress', '');
    const without = await (await request.get('/api/crashes/disclosures')).json();
    expect(without.rows.map((r: any) => r.id)).toEqual(['crash', 'crash-settings', 'crash-config']);
    expect(without.goesTo).toContain('developers');
    setSettingInFile('emailAddress', 'fpp-tests@example.invalid');
    const withMail = await (await request.get('/api/crashes/disclosures')).json();
    expect(withMail.rows.map((r: any) => r.id)).toEqual(['crash', 'crash-settings', 'crash-config', 'email']);
  });
});

test('a Diagnostic Report carries the troubleshooting output, without what identifies the user', async ({ request }) => {
  // Feature: a34aeb64c.  POST /api/crashes/report builds a level-3 report
  // with the Troubleshooting page's output and the health check, through the
  // redactor; pii commands run their cut-down manualCrashReportCmd or are
  // left out, so the process list has no command lines.
  // Feature: 1a88db3bc -- the report is kept in crashes/, sent nowhere, and
  // not counted as a crash in the status warnings.
  test.setTimeout(330_000);
  let file = '';
  try {
    const r = await request.post('/api/crashes/report', { data: { client: 'fpp-tests' }, timeout: 300_000 });
    const body = await r.json();
    expect(body.Status, JSON.stringify(body)).toBe('OK');
    file = body.File;
    expect(file).toMatch(/^fpp-[A-Za-z0-9._-]+-manual\.zip$/);
    const path = `${CRASHES}/${file}`;
    const names = zipNames(path);
    expect(names).toEqual(expect.arrayContaining(['settings', 'logs/troubleshootingCommands.log', 'logs/healthCheck.log']));
    const log = zipMember(path, 'logs/troubleshootingCommands.log');
    expect(log).toContain('Troubleshooting Commands:');

    const groups = JSON.parse(inPlayer('cat', '/opt/fpp/www/troubleshoot-commands.json')).CommandGroups;
    const omitted: string[] = [];
    for (const g of Object.values<any>(groups)) {
      for (const c of Object.values<any>(g.commands)) {
        if (c.pii && !c.manualCrashReportCmd) omitted.push(c.title);
      }
    }
    let checked = 0;
    for (const title of omitted) {
      const at = log.indexOf(`Title  : ${title}\n`);
      if (at < 0) continue;  // not on this platform
      checked++;
      const end = log.indexOf('\nTitle  : ', at + 1);
      const section = log.slice(at, end < 0 ? undefined : end);
      expect(section, `${title} ran in the report`).toContain('** omitted from crash report (pii) **');
    }
    expect(checked, 'no pii command ran on this platform, so this proves nothing').toBeGreaterThan(0);
    // A command line from this player's process list: the web test server.
    expect(log, 'the process list carries command lines').not.toContain('web_serve.py');

    const status = await (await request.get('/api/system/status')).json();
    expect(JSON.stringify(status.warnings || []), 'a report on request counted as a crash').not.toMatch(/crash report/i);
  } finally {
    if (file) inPlayer('rm', '-f', `${CRASHES}/${file}`);
  }
});

test('the logs zip keeps JSON settings whole and leaves out stale Diagnostic Report files', async ({ request }) => {
  // Regression: 5232d8091.  The settings file was read with parse_ini_file(),
  //   which strips the quotes inside a JSON value (privacyConsent came out
  //   mangled) and fails outright on a JSON array, leaving it empty.
  // Feature: efdd07c42 -- the zip no longer runs the troubleshooting commands
  //   and ignores the stale troubleshootingCommands.log / healthCheck.log that
  //   older versions left in logs/.
  const stale = [`${MEDIA}/logs/troubleshootingCommands.log`, `${MEDIA}/logs/healthCheck.log`];
  await keepingSettings(() => keepingFile(stale[0], () => keepingFile(stale[1], async () => {
    inPlayer('sh', '-c', `sed -i '/^keyBindings /d' ${MEDIA}/settings; printf '%s\\n' 'keyBindings = [{"key":"F9","command":"fpp-tests"}]' >> ${MEDIA}/settings`);
    for (const f of stale) writeFile(f, 'fpp-tests stale copy\n');
    const consentLine = inPlayer('grep', '^privacyConsent ', `${MEDIA}/settings`).trim();
    const r = await request.get('/api/files/zip/logs', { timeout: 60_000 });
    expect(r.ok()).toBe(true);
    const zip = `/tmp/fpp-tests-logs-${process.pid}.zip`;
    writeFile(zip, await r.body());
    try {
      const names = zipNames(zip);
      const settingsName = names.find((n) => n === 'settings' || n.endsWith('/settings'));
      expect(settingsName, `no settings file: ${names}`).toBeDefined();
      const settings = zipMember(zip, settingsName!);
      expect(settings).toContain(consentLine);
      expect(settings).toContain('keyBindings = [{"key":"F9","command":"fpp-tests"}]');
      expect(names.filter((n) => /troubleshootingCommands\.log|healthCheck\.log/.test(n)), 'stale diagnostics zipped').toEqual([]);
    } finally {
      inPlayer('rm', '-f', zip);
    }
  })));
});

test('File Manager > Logs offers the Diagnostic Report, not the old Zip', async ({ page }) => {
  // Feature: efdd07c42.
  await page.goto('/filemanager.php');
  await page.click('#tab-logs-tab');
  const pane = page.locator('#tab-logs');
  await expect(pane.locator('input[value="Diagnostic Report"]')).toBeVisible();
  await expect(pane.locator('input[value="Zip"]')).toHaveCount(0);
});

test('the health check counts every fppd warning', async ({ request }) => {
  // Regression: 779bcb463.  The summary counted the warnings file as one
  // warning however many it held.
  const WARNINGS = '/opt/fpp/www/warnings.json';
  const summary = async () => {
    const text = await (await request.get(`/healthCheckSSE.php?timestamp=${Math.floor(Date.now() / 1000)}`, { timeout: 120_000 })).text();
    const done = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((e) => e.id === 'done');
    expect(done, text.slice(-2000)).toBeDefined();
    return done.summary;
  };
  test.setTimeout(300_000);
  await keepingFile(WARNINGS, async () => {
    writeFile(WARNINGS, '[]');
    const none = await summary();
    writeFile(WARNINGS, JSON.stringify(['fpp-tests warning one', 'fpp-tests warning two', 'fpp-tests warning three']));
    const three = await summary();
    expect(three.warn - none.warn, `${JSON.stringify(none)} -> ${JSON.stringify(three)}`).toBe(3);
  });
});

test('the Webserver tab renders server pages in a frame that runs no scripts', async ({ page, request }) => {
  // Regression: cd4527272.  phpinfo and server-status were dumped as raw
  // markup in a <pre>, hard-wrapped at 160 columns by fold.
  const r = await request.get('/troubleshootingHelper.php?key=WebPHPInfo');
  expect(r.headers()['content-type'] || '').not.toContain('text/plain');
  const text = await r.text();
  expect(text).toMatch(/^\s*</);
  expect(Math.max(...text.split('\n').map((l) => l.length)), 'the page was folded at 160 columns').toBeGreaterThan(160);

  await page.goto('/troubleshooting.php');
  await page.getByRole('tab', { name: /Webserver/ }).click();
  const frame = page.locator('iframe[title="Command output"]').first();
  await expect(frame).toBeAttached({ timeout: 60_000 });
  const sandbox = await frame.getAttribute('sandbox');
  expect(sandbox).not.toBeNull();
  expect(sandbox!).not.toContain('allow-scripts');
});

test('Cape Info contacts no signing service and loads no remote script for an unsigned cape', async ({ page }) => {
  // Regression: afcf89ea3.  Every view loaded a <script> from the signing
  // API and fetched it, for a signing UI that only a cape on a licensed
  // driver ever shows.
  const CAPE = `${MEDIA}/tmp/cape-info.json`;
  await keepingFile(CAPE, async () => {
    writeFile(CAPE, JSON.stringify({ id: 'fpp-tests-cape', name: 'Test Cape', designer: 'fpp-tests', version: '1.0' }));
    const remote: string[] = [];
    page.on('request', (r) => {
      const host = new URL(r.url()).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') remote.push(r.url());
    });
    await page.goto('/cape-info.php');
    await page.waitForLoadState('networkidle');
    expect(remote.filter((u) => /falconplayer\.com/.test(u)), 'Cape Info contacted the signing API').toEqual([]);
    const html = await page.content();
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\/[^"']*falconplayer/);
  });
});

test('the About page loads nothing from PayPal', async ({ page, request }) => {
  // Regression: 308874d58.  A 1x1 tracking pixel from paypal.com fired on
  // every view, and the CSP allowed PayPal images.
  const hits: string[] = [];
  page.on('request', (r) => { if (/paypal(objects)?\.com/.test(r.url())) hits.push(r.url()); });
  await page.goto('/about.php');
  await page.waitForLoadState('networkidle');
  expect(hits).toEqual([]);
  const csp = (await request.get('/about.php')).headers()['content-security-policy'] || '';
  expect(csp, 'no CSP header, so this proves nothing').toContain('img-src');
  expect(csp.match(/img-src[^;]*/)![0]).not.toMatch(/paypal/);
});

test('F8 builds a Diagnostic Report, waits on the Build step, and closing keeps it; F1 explains it', async ({ page }) => {
  // Feature: dc0999351 (the wizard's final flow: Build, then Next to Send;
  //   closing keeps the report in crashes/).
  // Regression: 1b255299d -- F1 with the wizard open showed nothing over it;
  //   it now shows the Diagnostic Report's help above the wizard, and the
  //   page's own help page is unchanged afterwards.
  test.setTimeout(330_000);
  const before = inPlayer('sh', '-c', `ls ${CRASHES} 2>/dev/null || true`).split('\n').filter(Boolean);
  try {
    await page.goto('/index.php');
    const ownHelp = await page.evaluate(() => (window as any).helpPage);
    await page.keyboard.press('F8');
    const dlg = page.locator('#errorReportDialog');
    await expect(dlg).toBeVisible();

    await page.keyboard.press('F1');
    const help = page.locator('#helpDialog');
    await expect(help).toBeVisible();
    await expect(page.locator('#helpDialogText')).toContainText('Diagnostic Report', { timeout: 10_000 });
    const z = (sel: string) => page.locator(sel).evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10) || 0);
    expect(await z('#helpDialog'), 'the help is under the wizard').toBeGreaterThan(await z('#errorReportDialog'));
    await help.locator('.btn-close').first().click();
    await expect(help).toBeHidden();
    await expect(dlg, 'closing the help closed the wizard').toBeVisible();
    expect(await page.evaluate(() => (window as any).helpPage), "the page's own help changed").toBe(ownHelp);

    // fppd builds one report at a time and none for 10 s after the last (an
    // earlier test here builds one).
    await page.waitForTimeout(11_000);
    await page.click('#errorReportNextBtn');  // Build Report
    await expect(page.locator('#errorReportDownloadArea').or(page.locator('#errorReportStatus .alert-danger, #errorReportStatus .text-danger')))
      .toBeVisible({ timeout: 300_000 });
    await expect(page.locator('#errorReportDownloadArea'), await page.locator('#errorReportStatus').innerText()).toBeVisible();
    const built = inPlayer('sh', '-c', `ls ${CRASHES}`).split('\n').filter((n) => n.endsWith('-manual.zip') && !before.includes(n));
    expect(built).toHaveLength(1);
    await expect(page.locator('#errorReportDownloadText')).toContainText(built[0]);
    // No auto-advance: the user checks what was built, then Next.
    await expect(page.locator('#erStepBody1')).toBeVisible();
    await expect(page.locator('#erStepBody2')).toBeHidden();
    await page.click('#errorReportNextBtn');
    await expect(page.locator('#erStepBody2')).toBeVisible();

    await page.keyboard.press('F8');  // closes, as a second F8 does
    await expect(dlg).toBeHidden();
    expect(inPlayer('sh', '-c', `ls ${CRASHES}`), 'closing the wizard deleted the report').toContain(built[0]);
  } finally {
    const now = inPlayer('sh', '-c', `ls ${CRASHES} 2>/dev/null || true`).split('\n').filter(Boolean);
    for (const n of now) if (!before.includes(n)) inPlayer('rm', '-f', `${CRASHES}/${n}`);
  }
});
