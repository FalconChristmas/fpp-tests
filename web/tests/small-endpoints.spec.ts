import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container, docker, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';
import { keepingFile } from './privacy-helpers';
import { SecondPlayer } from './second-player';
import { StandIn } from './standin-http';

// The small PHP pages behind the About page, the Health Check and MultiSync:
// what each answers, and what it runs (or doesn't) in the shell it hands its
// input to.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// A file the injected commands would make.
const MARKER = '/tmp/fpp-tests-injected';
// A command that makes MARKER with no '/' in it, for values a basename() is
// taken of.
const TOUCH_MARKER = `touch $(echo ${Buffer.from(MARKER).toString('base64')}|base64 -d)`;
const UPGRADE_LOG = `${MEDIA}/logs/fpp_system_upgrades.log`;

test.beforeEach(() => inPlayer('rm', '-f', MARKER));
test.afterEach(() => inPlayer('rm', '-f', MARKER));

// upgradeOS.php with its OS upgrade script, upgradeOS-part1.sh, stood in for
// by one that records it was run and fails (so the page never goes on to
// reboot).  The page copies it out of /opt/fpp/SD, which in this container is
// a link into the build tree other runs share, so it is swapped for a copy of
// its own for the length of fn.  The upgrade log the page writes is put back
// after.
const RAN = '/tmp/fpp-tests-part1.ran';
async function withStandInUpgrade(fn: () => Promise<void>) {
  const SD = '/opt/fpp/SD';
  inPlayer('sh', '-c', `set -e; rm -f ${RAN}; mv ${SD} ${SD}.fpp-tests-orig; cp -aL ${SD}.fpp-tests-orig ${SD}
    printf '#!/bin/sh\\necho "$*" >> ${RAN}\\necho fpp-tests stand-in part1; exit 1\\n' > ${SD}/upgradeOS-part1.sh
    chmod 755 ${SD}/upgradeOS-part1.sh`);
  try {
    await keepingFile(UPGRADE_LOG, fn);
  } finally {
    inPlayer('sh', '-c', `rm -rf ${SD} && mv ${SD}.fpp-tests-orig ${SD}; rm -f ${RAN} ${MEDIA}/tmp/upgradeOS-part1.sh`);
  }
}

// By POST with the image in the query string, as About's StreamURL() asks.
async function upgradeOS(request: import('@playwright/test').APIRequestContext, os: string) {
  const r = await request.post(`/upgradeOS.php?wrapped=1&os=${encodeURIComponent(os)}`, { timeout: 60_000 });
  return r.text();
}

test('an OS upgrade of an image that is missing or empty says so and runs nothing', async ({ request }) => {
  // Regression: 0147a7634 ("Display better error if FPPOS not found during
  // upgrade", #2573).  An image name with no file behind it, or an empty one,
  // went straight to the upgrade script, which failed somewhere inside.
  const EMPTY = `${MEDIA}/upload/fpp-tests-empty.fppos`;
  const GOOD = `${MEDIA}/upload/fpp-tests-good.fppos`;
  await withStandInUpgrade(async () => {
    putFile(EMPTY, '');
    putFile(GOOD, 'fpp-tests image');
    try {
      let body = await upgradeOS(request, 'fpp-tests-missing.fppos');
      expect(body).toContain(`File does not exist, aborting: ${MEDIA}/upload/fpp-tests-missing.fppos`);
      expect(exists(RAN), `the upgrade ran on a missing image:\n${body}`).toBe(false);
      body = await upgradeOS(request, 'fpp-tests-empty.fppos');
      expect(body).toContain(`File is empty, aborting: ${EMPTY}`);
      expect(exists(RAN), `the upgrade ran on an empty image:\n${body}`).toBe(false);
      // The control: an image that is there goes on to the (stand-in) upgrade.
      body = await upgradeOS(request, 'fpp-tests-good.fppos');
      expect(readFile(RAN).trim(), body).toBe(GOOD);
    } finally {
      inPlayer('rm', '-f', EMPTY, GOOD);
    }
  });
});

test('an OS image too big for the free space on the root filesystem is not applied', async ({ request }) => {
  // Regression: 45e34275c ("Add pre-flight disk space checks before applying
  // an FPP OS upgrade", #2820).  The upgrade copies the new OS over the
  // running root, and with too little room it died part way, leaving a root
  // that cannot boot.  The image here is a sparse file: as big as asked, and
  // taking no space.  (The same check in upgradeOS-part1.sh is not run here:
  // when it passes, part1 goes on to rewrite the player's root.)
  const BIG = `${MEDIA}/upload/fpp-tests-big.fppos`;
  const SMALL = `${MEDIA}/upload/fpp-tests-small.fppos`;
  await withStandInUpgrade(async () => {
    const free = parseInt(inPlayer('sh', '-c', "df -B1 --output=avail / | tail -1").trim(), 10);
    // More than half what is free: the copy needs room for the image and the OS it holds.
    inPlayer('truncate', '-s', String(Math.floor(free / 2) + 1024 * 1024 * 1024), BIG);
    putFile(SMALL, 'fpp-tests image');
    try {
      let body = await upgradeOS(request, 'fpp-tests-big.fppos');
      expect(body).toContain('Not enough free space on the root filesystem to apply fpp-tests-big.fppos');
      expect(exists(RAN), `the upgrade ran with too little room:\n${body}`).toBe(false);
      // The control: an image that fits goes on to the (stand-in) upgrade.
      body = await upgradeOS(request, 'fpp-tests-small.fppos');
      expect(readFile(RAN).trim(), body).toBe(SMALL);
    } finally {
      inPlayer('rm', '-f', BIG, SMALL);
    }
  });
});

test('an OS image download streams a handful of progress lines, not one per redraw', async ({ request }) => {
  // Regression: a8f128d9d ("stop wget's progress bar from flooding the OS
  // upgrade dialog with a line per redraw").  wget drew a progress bar,
  // redrawn with a \r several times a second, and every redraw reached the
  // dialog as more output.  The image comes from a server in the player
  // that sends 24 MB over a few seconds, long enough for many redraws.
  // The receiving end is wget's own output, so it takes a real wget.
  test.skip(inPlayer('sh', '-c', 'command -v wget || true').trim() === '', 'the player image has no wget');
  const NAME = 'fpp-tests-slow.fppos';
  const SIZE = 24 * 1024 * 1024;
  const server = `
import http.server, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', '${SIZE}')
        self.end_headers()
        chunk = b'x' * 65536
        for i in range(${SIZE} // 65536):
            self.wfile.write(chunk)
            if i % 16 == 0:
                time.sleep(0.25)
    def log_message(self, *a):
        pass
http.server.HTTPServer(('127.0.0.1', 8783), H).serve_forever()
`;
  putFile('/tmp/fpp-tests-slow-server.py', server);
  docker('exec', '-d', container, 'python3', '/tmp/fpp-tests-slow-server.py');
  try {
    await expect.poll(() => inPlayer('sh', '-c', 'curl -s -o /dev/null -r 0-0 -w "%{http_code}" --max-time 2 http://127.0.0.1:8783/x || true').trim(),
      { timeout: 10_000 }).toMatch(/^20/);
    await keepingFile(UPGRADE_LOG, async () => {
      const r = await request.get(`/upgradeOS.php?wrapped=1&downloadOnly=1&os=${encodeURIComponent(`http://127.0.0.1:8783/${NAME}`)}`, { timeout: 120_000 });
      const body = await r.text();
      // The control: the image arrived, whole.
      expect(parseInt(inPlayer('stat', '-c', '%s', `${MEDIA}/upload/${NAME}`).trim(), 10), body.slice(-500)).toBe(SIZE);
      expect(body).toContain('Download complete');
      const redraws = (body.match(/\r/g) || []).length;
      expect(redraws, `the progress came as ${redraws} redraws`).toBeLessThanOrEqual(2);
      expect(body.split('\n').length).toBeLessThan(40);
    });
  } finally {
    inPlayer('sh', '-c', "pkill -f 'python3 /tmp/[f]pp-tests-slow-server' || true");
    inPlayer('rm', '-f', '/tmp/fpp-tests-slow-server.py', `${MEDIA}/upload/${NAME}`);
  }
});

test('an OS image name that is not a plain file name is refused', async ({ request }) => {
  // Regression: 9bbf886ea ("prevent argument injection in OS upgrade via
  // escapeshellcmd misuse").  A local image name went through
  // escapeshellcmd(), which leaves spaces and leading dashes alone, into the
  // upgrade script's command line, so one name could be several arguments.
  // (shell-input-refused.spec.ts has the URL form.)
  await withStandInUpgrade(async () => {
    expect(TOUCH_MARKER).not.toContain('/');
    for (const os of [`fpp-tests;${TOUCH_MARKER}`, `$(${TOUCH_MARKER}).fppos`, 'fpp-tests a.fppos', '-fpp-tests --x.fppos', 'fpp-tests`id`.fppos']) {
      const body = await upgradeOS(request, os);
      expect(body, os).toContain('Invalid OS filename');
      expect(body, os).not.toContain('File does not exist');
      expect(exists(RAN), os).toBe(false);
    }
    expect(exists(MARKER), 'an image name ran a command').toBe(false);
  });
});

test('a Health Check timestamp that is not a number runs nothing', async ({ request }) => {
  // Regression: 7e9f4f801 ("Validate timestamp input in healthCheckHelper.php").
  // The timestamp went onto the healthCheck command line as given.
  test.setTimeout(180_000);
  const r = await request.get(`/healthCheckHelper.php?timestamp=${encodeURIComponent(`1;touch ${MARKER}`)}`, { timeout: 150_000 });
  const body = await r.text();
  // The control: the check itself ran.
  expect(body).toContain('checkNumber');
  expect(exists(MARKER), 'the timestamp ran a command').toBe(false);
});

test('Restart FPPD on a remote says which mode it set, and the remote takes it', async ({ request }) => {
  // Regression: ac5ca97e6 ("Update echo line for $mode variable").  The line
  // printed $mode before it was set: "Setting FPPD mode @ <ip> to " and
  // nothing.  The remote is a stand-in on a host of its own that records what
  // it is sent (a real one's fppd quits for the restart, and its container
  // with it); the mode change and restart it got are then sent to a second
  // real player, which has to take them.
  //
  // And the restart is a quick one.  The page asked for quick=true, which
  // the remote's RestartFPPD() never took ("true" == 1 is false in PHP), so
  // every remote got a full stop and start; the fppMode setting only needs a
  // quick one.  A quick restart re-execs fppd in place, so its pid stays.
  test.setTimeout(300_000);
  const remote = StandIn.sibling('restart', {
    '/api/settings/fppMode': { json: { status: 'OK' } },
    '/api/system/fppd/restart': { json: { status: 'OK' } },
    '/api/fppd/status': { json: { status: 0, status_name: 'idle' } },
  });
  let put: { method: string; path: string; body: string } | undefined;
  let restart: { method: string; path: string; body: string } | undefined;
  try {
    remote.start();
    // By POST with the query string, as the MultiSync page's quick stream asks.
    const r = await request.post(`/restartRemoteFPPD.php?ip=${remote.address}&mode=remote`, { timeout: 120_000 });
    const body = await r.text();
    expect(body).toContain(`Setting FPPD mode @ ${remote.address} to remote\n`);
    expect(body).toContain('FPPD Restarted');
    const sent = remote.requests();
    put = sent.find((q) => q.path === '/api/settings/fppMode');
    expect(put?.method).toBe('PUT');
    restart = sent.find((q) => q.path.split('?')[0] === '/api/system/fppd/restart');
    expect(restart, 'the remote was not asked to restart').toBeDefined();
    // quick=1, the value the API documents: a remote of any FPP since 5.0
    // takes it, where only one with this fix takes quick=true.
    expect(new URLSearchParams(restart!.path.split('?')[1] ?? '').get('quick'), restart!.path).toBe('1');
  } finally {
    remote.stop();
  }
  // The receiving end: a real player given those requests restarts quickly,
  // in remote mode.
  const peer = new SecondPlayer('mode').start();
  const pid = () => peer.sh('pidof fppd || true').trim();
  const logged = (line: string) => Number(peer.sh(`grep -c "${line}" /home/fpp/media/logs/fppd.log || true`).trim());
  const restartedQuickly = (path: string, method: string, mode: string) => {
    const before = pid();
    const down = logged('Shutting down main loop');
    const up = logged('Starting main processing loop');
    expect(before, 'no fppd running before the restart').toMatch(/^\d+$/);
    peer.sh(`curl -s -X ${method} --max-time 30 'http://127.0.0.1${path}'`);
    // Restarted: its main loop shut down and started again (the old one
    // answers the API while it shuts down, so an answer alone is not it).
    let status: any;
    for (let i = 0; i < 60; i++) {
      execFileSync('sleep', ['1']);
      try {
        status = logged('Starting main processing loop') > up ? peer.get('/api/fppd/status') : undefined;
      } catch {
        status = undefined;
      }
      if (status?.mode_name) break;
    }
    // A full stop takes the player's fppd out from under web_serve.py, and
    // the player goes down with it.
    expect(docker('inspect', '-f', '{{.State.Running}}', peer.name).trim(),
      `${path}: fppd was stopped, not restarted in place (the player went down with it)`).toBe('true');
    expect(logged('Shutting down main loop'), `${path}: fppd never shut down for the restart`).toBeGreaterThan(down);
    expect(status?.mode_name, `${path}: ${JSON.stringify(status)}`).toBe(mode);
    expect(pid(), `${path}: fppd was stopped and started again, not restarted in place`).toBe(before);
  };
  try {
    expect(peer.get('/api/settings/fppMode').value).not.toBe('remote');
    peer.sh(`curl -s -X ${put!.method} --data-binary '${put!.body}' 'http://127.0.0.1${put!.path}'`);
    expect(peer.get('/api/settings/fppMode').value).toBe('remote');
    restartedQuickly(restart!.path, restart!.method, 'remote');
    // An older player's MultiSync still sends quick=true; the remote takes
    // that as quick too.
    restartedQuickly('/api/system/fppd/restart?quick=true', 'POST', 'remote');
  } catch (e) {
    // Its own failure first: a full restart also takes the player's fppd
    // out from under web_serve.py, which stop()'s verdict then reports.
    peer.stop();
    throw e;
  }
  const verdict = peer.stop();
  expect(verdict.ok, verdict.detail).toBe(true);
});

test('a branch change asked for by a script or a remote gets no page script in its output', async ({ request }) => {
  // Regression: a1ddad2da ("suppress script output when calling change branch
  // from remote system").  changebranch.php put a <script> after every line
  // of git_branch's output, and a link and another script after it, whoever
  // asked: a MultiSync branch change (a PHP curl request, no User-Agent) or
  // curl relayed them into its own output.  A browser still gets them.  Each
  // asks by POST, as FPP's own callers do (remoteJobs.inc.php's RemoteJobHttp
  // with postFields set, the UI through PostNavigate): a GET is deprecated,
  // and one from the player's own loopback is what state-changing-posts.spec.ts
  // looks for in fppd.log.  The branch switch itself, scripts/git_branch, is
  // stood in for by one that prints a few lines.
  const SCRIPT = '/opt/fpp/scripts/git_branch';
  inPlayer('cp', '-p', SCRIPT, `${SCRIPT}.fpp-tests-orig`);
  putFile(SCRIPT, '#!/bin/sh\necho "fpp-tests git_branch $*"\necho "fpp-tests second line"\n');
  try {
    const url = 'http://127.0.0.1/changebranch.php?branch=master&remote=origin';
    const asked: Record<string, string> = {
      curl: inPlayer('curl', '-s', '--max-time', '60', '-X', 'POST', '-d', '', url),
      // As remoteJobs.inc.php's RemoteJobHttp asks: PHP's curl, a POST with
      // an empty body, no User-Agent.
      'a remote job': execFileSync('docker', ['exec', '-i', container, 'php', '-r',
        `$c = curl_init('${url}'); curl_setopt($c, CURLOPT_RETURNTRANSFER, true); curl_setopt($c, CURLOPT_TIMEOUT, 60); ` +
        `curl_setopt($c, CURLOPT_POST, true); curl_setopt($c, CURLOPT_POSTFIELDS, ''); echo curl_exec($c);`],
      { encoding: 'utf8' }),
    };
    for (const [who, body] of Object.entries(asked)) {
      // The control: the switch ran and its output came back.
      expect(body, who).toContain('fpp-tests git_branch master origin');
      expect(body, who).not.toContain('window.scrollTo');
      expect(body, who).not.toContain('Go to FPP Main Status Page');
    }
    const browser = await (await request.post('/changebranch.php?branch=master&remote=origin', {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) fpp-tests' }, timeout: 60_000,
    })).text();
    expect(browser).toContain('fpp-tests git_branch master origin');
    expect(browser).toContain('<script>window.scrollTo(0, document.body.scrollHeight);</script>');
    expect(browser).toContain('Go to FPP Main Status Page');
  } finally {
    inPlayer('mv', '-f', `${SCRIPT}.fpp-tests-orig`, SCRIPT);
  }
});
