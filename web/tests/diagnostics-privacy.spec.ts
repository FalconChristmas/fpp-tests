import { execFileSync } from 'child_process';
import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';
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
    // Also 539ad204b: the crash row's text names the host the report goes to,
    // the one uploadTarget gives, not the old server.
    const target = await (await request.get('/api/crashes/uploadTarget')).json();
    expect(without.rows.find((r: any) => r.id === 'crash').body).toContain(new URL(target.url).host);
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

test('a Diagnostic Report carries the end of the plugin manager and upgrade logs, redacted', async ({ request }) => {
  // Feature: a34aeb64c.  The plugin manager's and the FPP upgrades' logs go
  // into a Diagnostic Report through the redactor, each cut to its last MiB
  // (from a line start) so a long-lived log can't swell the report.
  test.setTimeout(330_000);
  const PLUGIN_LOG = `${MEDIA}/logs/fpp_plugin_manager.log`;
  const UPGRADE_LOG = `${MEDIA}/logs/fpp_system_upgrades.log`;
  const secret = 'FppTestsSecret8c1';
  await keepingFile(PLUGIN_LOG, () => keepingFile(UPGRADE_LOG, async () => {
    writeFile(PLUGIN_LOG, `fpp-tests plugin line\nclone https://fpp-tests:${secret}@example.invalid/r.git\npassword=${secret}\n`);
    // 1.2 MiB: a first line, filler, and a last line.
    const filler = Array.from({ length: 20_000 }, (_, i) => `fpp-tests upgrade filler line ${String(i).padStart(6, '0')} ..................`).join('\n');
    writeFile(UPGRADE_LOG, `FPP-TESTS-FIRST-LINE\n${filler}\nFPP-TESTS-LAST-LINE\n`);
    expect(Number(inPlayer('stat', '-c', '%s', UPGRADE_LOG))).toBeGreaterThan(1048576);
    let file = '';
    try {
      // One report per 10 s: the test before may have just built one.
      let body: any;
      const until = Date.now() + 30_000;
      do {
        if (body) await new Promise((res) => setTimeout(res, 1_000));
        body = await (await request.post('/api/crashes/report', { data: { client: 'fpp-tests' }, timeout: 300_000 })).json();
      } while (body.Code === 'rate-limited' && Date.now() < until);
      expect(body.Status, JSON.stringify(body)).toBe('OK');
      file = body.File;
      const path = `${CRASHES}/${file}`;
      expect(zipNames(path)).toEqual(expect.arrayContaining(['logs/fpp_plugin_manager.log', 'logs/fpp_system_upgrades.log']));

      const plugins = zipMember(path, 'logs/fpp_plugin_manager.log');
      // The control: the log is the one planted.
      expect(plugins).toContain('fpp-tests plugin line');
      expect(plugins, 'a secret in the plugin manager log was not redacted').not.toContain(secret);

      const upgrades = zipMember(path, 'logs/fpp_system_upgrades.log');
      expect(upgrades).toContain('FPP-TESTS-LAST-LINE');
      expect(upgrades, 'the upgrades log was not cut to its end').not.toContain('FPP-TESTS-FIRST-LINE');
      expect(upgrades.length).toBeLessThanOrEqual(1048576);
      // Cut at a line start: the first line is a whole filler line.
      expect(upgrades.split('\n')[0]).toMatch(/^fpp-tests upgrade filler line \d{6} \.+$/);
    } finally {
      if (file) inPlayer('rm', '-f', `${CRASHES}/${file}`);
    }
  }));
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

// The API as it answers when fppd is not running, while the suite's fppd goes
// on running (web_serve.py fails the run if it stops): www/api/index.php
// served by PHP's own web server in the player, with an LD_PRELOAD shim that
// refuses every connect() to fppd's port 32322.  So PostCrashReport() gets no
// reply from fppd, FppdListening() finds nothing listening, and the real
// BuildManualCrashReportWithoutFppd() builds the report, with the real
// generate_crash_report (whose own calls to fppd are refused too, as they
// would be).  The server and its builds run as root, as php-fpm does here.
class ApiWithoutFppd {
  static readonly PORT = 18322;
  private static readonly SHIM = '/tmp/fpp-tests-no-fppd.so';

  static start(): ApiWithoutFppd {
    writeFile('/tmp/fpp-tests-no-fppd.c', `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <sys/socket.h>
int connect(int fd, const struct sockaddr *sa, socklen_t len) {
    static int (*real)(int, const struct sockaddr *, socklen_t);
    if (!real) real = (int (*)(int, const struct sockaddr *, socklen_t))dlsym(RTLD_NEXT, "connect");
    unsigned short port = 0;
    if (sa && sa->sa_family == AF_INET) port = ntohs(((const struct sockaddr_in *)sa)->sin_port);
    if (sa && sa->sa_family == AF_INET6) port = ntohs(((const struct sockaddr_in6 *)sa)->sin6_port);
    if (port == 32322) { errno = ECONNREFUSED; return -1; }
    return real(fd, sa, len);
}
`);
    inPlayer('gcc', '-shared', '-fPIC', '-o', ApiWithoutFppd.SHIM, '/tmp/fpp-tests-no-fppd.c', '-ldl');
    // Two workers: a second request is answered while the first builds.
    docker('exec', '-d', '-w', '/opt/fpp/www', '-e', 'PHP_CLI_SERVER_WORKERS=2', '-e', `LD_PRELOAD=${ApiWithoutFppd.SHIM}`, container,
      'php', '-S', `127.0.0.1:${ApiWithoutFppd.PORT}`, '-t', '/opt/fpp/www');
    const api = new ApiWithoutFppd();
    for (let i = 0; i < 100; i++) {
      try {
        if (api.call('GET', 'crashes/uploadTarget').Status === 'OK') return api;
      } catch {
        // not up yet
      }
      execFileSync('sleep', ['0.1']);
    }
    api.stop();
    throw new Error('PHP\'s server did not start');
  }

  url(path: string): string {
    return `http://127.0.0.1:${ApiWithoutFppd.PORT}/api/index.php/${path}`;
  }

  call(method: string, path: string): any {
    return JSON.parse(inPlayer('curl', '-sS', '--max-time', '300', '-X', method,
      ...(method === 'POST' ? ['-H', 'Content-Type: application/json', '-d', '{"client":"fpp-tests"}'] : []), this.url(path)));
  }

  stop() {
    // A build a failed test left running goes too.
    inPlayer('sh', '-c', `pkill -f '[p]hp -S 127.0.0.1:${ApiWithoutFppd.PORT}'; pkill -f '[g]enerate_crash_report 3 .*/manual-crash-php/'; ` +
      `rm -f ${ApiWithoutFppd.SHIM} /tmp/fpp-tests-no-fppd.c; true`);
  }
}

// The player's local time, as the API stamps a report's name (with date(1)).
function playerStamp(): string {
  return inPlayer('date', '+%Y-%m-%d_%H-%M-%S').trim();
}

// fppd's own Diagnostic Report, waiting out its 10 s after an earlier build.
async function fppdReport(request: any): Promise<any> {
  let body: any;
  const until = Date.now() + 30_000;
  do {
    if (body) await new Promise((res) => setTimeout(res, 1_000));
    body = await (await request.post('/api/crashes/report', { data: { client: 'fpp-tests' }, timeout: 300_000 })).json();
  } while (body.Code === 'rate-limited' && Date.now() < until);
  return body;
}

test.describe('a Diagnostic Report with fppd not running', () => {
  let api: ApiWithoutFppd | undefined;
  let kept = '';
  const PHPTMP = `${MEDIA}/tmp/manual-crash-php`;

  test.beforeEach(() => {
    // The manual reports already here (none, normally) wait outside, since at
    // most two are kept and the newest one sets the rate limit.
    kept = `/tmp/fpp-tests-kept-manual-${process.pid}`;
    inPlayer('sh', '-c', `mkdir -p ${CRASHES} ${kept} && for f in ${CRASHES}/*-manual.zip; do [ -e "$f" ] && mv "$f" ${kept}/; done; true`);
    api = ApiWithoutFppd.start();
  });
  test.afterEach(() => {
    api?.stop();
    inPlayer('sh', '-c', `rm -rf ${CRASHES}/*-manual.zip ${CRASHES}/*-fpp-tests-*.zip ${PHPTMP} ${PHPTMP}.lock /tmp/fpp-tests-no-fppd-*.json; ` +
      `for f in ${kept}/*; do [ -e "$f" ] && mv "$f" ${CRASHES}/; done; rmdir ${kept}; true`);
  });

  const manualReports = () => inPlayer('sh', '-c', `cd ${CRASHES} && ls *-manual.zip 2>/dev/null || true`).split('\n').filter(Boolean).sort();

  test('the API builds it itself, named as fppd names its own', async ({ request }) => {
    // Feature: 584744bc1.  When fppd is not running, POST /api/crashes/report
    // builds the report in PHP (BuildManualCrashReportWithoutFppd) and says
    // so with "Fppd":"not-running"; the name is CrashReportName()'s, as
    // fppd's own report is named.  Proved red with crashes.php at 584744bc1^
    // on master (the reply is Code unavailable: "fppd did not respond"), and
    // with the API's platform name for Docker changed (the names differ).
    test.setTimeout(660_000);
    const own = await fppdReport(request);
    expect(own.Status, JSON.stringify(own)).toBe('OK');
    expect(own.Fppd, 'fppd built its own report but the reply says it is not running').toBeUndefined();
    // Out of the API's 10 s after the last manual report.
    inPlayer('touch', '-d', '1 minute ago', `${CRASHES}/${own.File}`);

    const before = playerStamp();
    const r = api!.call('POST', 'crashes/report');
    const after = playerStamp();
    expect(r, JSON.stringify(r)).toMatchObject({ Status: 'OK', Fppd: 'not-running' });
    // fppd itself never stopped: the shim, not a dead fppd, made the difference.
    expect((await request.get('/api/fppd/status')).ok()).toBe(true);

    const name = /^(fpp-.+)-(\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d)-manual\.zip$/;
    const mine = r.File.match(name);
    const theirs = own.File.match(name);
    expect(mine, r.File).not.toBeNull();
    expect(theirs, own.File).not.toBeNull();
    // fpp-<platform>-<version>-<uuid>, the same as fppd's
    expect(mine[1], `${r.File} is not named as fppd's ${own.File}`).toBe(theirs[1]);
    // and the player's local time when it was built
    expect(mine[2] >= before && mine[2] <= after, `${mine[2]} not in ${before}..${after}`).toBe(true);

    const path = `${CRASHES}/${r.File}`;
    expect(r.Size).toBe(Number(inPlayer('stat', '-c', '%s', path)));
    // A level-3 Diagnostic Report, as fppd builds
    expect(zipNames(path)).toEqual(expect.arrayContaining(['settings', 'logs/fppd.log',
      'logs/troubleshootingCommands.log', 'logs/healthCheck.log']));
    expect(manualReports()).toEqual([own.File, r.File].sort());
    expect(inPlayer('cat', `${MEDIA}/logs/fppd.log`)).toContain(
      `crash report on request ${r.File} (level 3) built without fppd (not running), kept in crashes/ (client 'fpp-tests')`);
  });

  test('one is built at a time, none within 10 s of the last, and two are kept', async () => {
    // Feature: 584744bc1.  The API's build without fppd has fppd's limits:
    // one build at a time (its own lock), none for 10 s after the newest
    // manual report, and only the two newest manual reports kept.  A crash
    // report there is neither counted nor pruned.  Proved red with
    // crashes.php at 584744bc1^ on master, and with each limit changed in turn
    // (no lock: the second request builds; 5 s: built 7 s after; 15 s: refused
    // 12 s after; no pruning: the oldest report stays).
    test.setTimeout(660_000);
    const old = ['fpp-Docker-10.x-fpp-tests-uuid-2026-01-01_00-00-00-manual.zip', 'fpp-Docker-10.x-fpp-tests-uuid-2026-01-01_00-00-01-manual.zip'];
    const crash = 'fpp-Docker-10.x-fpp-tests-uuid-2026-01-01_00-00-02.zip';
    for (const [f, ago] of [[old[0], '3 minutes ago'], [old[1], '2 minutes ago'], [crash, '1 minute ago']]) {
      inPlayer('sh', '-c', `printf 'PK\\005\\006%018d' 0 > ${CRASHES}/${f} && touch -d '${ago}' ${CRASHES}/${f}`);
    }

    // The first build, in the background; while generate_crash_report runs
    // for it, a second request is turned away.
    const out = `/tmp/fpp-tests-no-fppd-${process.pid}.json`;
    docker('exec', '-d', container, 'sh', '-c', `curl -sS --max-time 300 -X POST -H 'Content-Type: application/json' -d '{"client":"fpp-tests"}' ` +
      `'${api!.url('crashes/report')}' > ${out}.part; mv ${out}.part ${out}`);
    const building = () => inPlayer('sh', '-c', `pgrep -f '[g]enerate_crash_report 3 .*/manual-crash-php/' > /dev/null && echo yes || true`).trim() === 'yes';
    const done = () => inPlayer('sh', '-c', `test -e ${out} && echo yes || true`).trim() === 'yes';
    await expect.poll(() => building() || done(), { timeout: 60_000, intervals: [100] }).toBe(true);
    // (Answered already, it is shown: an error, or a build too quick to overlap.)
    expect(done() ? inPlayer('cat', out) : 'building', 'the first request was answered before a second could be made').toBe('building');
    const second = api!.call('POST', 'crashes/report');
    expect(second, JSON.stringify(second)).toMatchObject({ Status: 'Error', Code: 'busy' });

    await expect.poll(done, { timeout: 300_000, intervals: [500] }).toBe(true);
    const first = JSON.parse(inPlayer('cat', out));
    expect(first, JSON.stringify(first)).toMatchObject({ Status: 'OK', Fppd: 'not-running' });
    // The oldest manual report went; the crash report stays.
    expect(manualReports()).toEqual([old[1], first.File].sort());
    expect(inPlayer('ls', CRASHES)).toContain(crash);

    // Straight after it, and 7 s after it: none.
    const soon = api!.call('POST', 'crashes/report');
    expect(soon, JSON.stringify(soon)).toMatchObject({ Status: 'Error', Code: 'rate-limited' });
    inPlayer('touch', '-d', '7 seconds ago', `${CRASHES}/${first.File}`);
    const still = api!.call('POST', 'crashes/report');
    expect(still, JSON.stringify(still)).toMatchObject({ Status: 'Error', Code: 'rate-limited' });
    expect(manualReports()).toEqual([old[1], first.File].sort());

    // 12 s after it: built, and the older of the two before it goes.
    inPlayer('touch', '-d', '12 seconds ago', `${CRASHES}/${first.File}`);
    const later = api!.call('POST', 'crashes/report');
    expect(later, JSON.stringify(later)).toMatchObject({ Status: 'OK', Fppd: 'not-running' });
    expect(later.File).not.toBe(first.File);
    expect(manualReports()).toEqual([first.File, later.File].sort());
    expect(inPlayer('ls', CRASHES)).toContain(crash);
  });
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

test('Cape Info does not reach the signing service from the server for an unsigned cape', async ({ request }) => {
  // Regression: afcf89ea3.  The page's PHP ran a curl to the signing API
  //   before it had read the cape, on every view, for an answer only the
  //   signing UI uses.  The API name is pointed at a listener inside the
  //   player (whose own curl is the control: it must register), and the
  //   page is fetched with a cape that needs no signing.
  const CAPE = `${MEDIA}/tmp/cape-info.json`;
  const HITS = `/tmp/fpp-tests-signing-hits-${process.pid}`;
  const LISTENER = `import socket,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(('127.0.0.1',443)); s.listen(8)
while True:
    c,_=s.accept(); open(sys.argv[1],'ab').write(b'x'); c.close()
`;
  const hits = () => parseInt(inPlayer('sh', '-c', `wc -c < ${HITS}`).trim(), 10);
  await keepingFile(HOSTS, () => keepingFile(CAPE, async () => {
    inPlayer('sh', '-c', `echo '127.0.0.1 api.falconplayer.com' >> ${HOSTS}; : > ${HITS}`);
    writeFile(`${HITS}.py`, LISTENER);
    docker('exec', '-d', container, 'sh', '-c', `echo $$ > ${HITS}.pid; exec python3 ${HITS}.py ${HITS}`);
    try {
      await expect.poll(() => {
        try { inPlayer('curl', '-sk', '-m', '3', 'https://api.falconplayer.com/'); } catch { /* the listener hangs up */ }
        return hits();
      }, { message: 'the stand-in signing service never saw a connection, so this proves nothing' }).toBeGreaterThan(0);
      inPlayer('sh', '-c', `: > ${HITS}`);
      writeFile(CAPE, JSON.stringify({ id: 'fpp-tests-cape', name: 'Test Cape', designer: 'fpp-tests', version: '1.0' }));
      const r = await request.get('/cape-info.php', { timeout: 30_000 });
      expect(r.ok()).toBe(true);
      expect(await r.text()).toContain('Test Cape');
      expect(hits(), 'the server contacted the signing API while rendering Cape Info').toBe(0);
    } finally {
      inPlayer('sh', '-c', `kill $(cat ${HITS}.pid); rm -f ${HITS} ${HITS}.py ${HITS}.pid; true`);
    }
  }));
});

test('the About page loads nothing from PayPal',async ({ page, request }) => {
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
