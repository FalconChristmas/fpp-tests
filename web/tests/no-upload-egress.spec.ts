import { test, expect } from './fixtures';
import { docker, container, inPlayer } from './container';
import { writeFile } from './privacy-helpers';

// No test run may reach FPP's real upload servers.  The setup project picks
// US, which turns statistics on, and two minutes later fppd publishes them
// (POST /api/statistics/usage, which posts to statsPublishUrl's default);
// crash reports go to the crash server from fppd's crash handler and from
// the Diagnostic Report's Send.  scripts/prepare-tree.sh points both names
// at loopback in every container the harness starts.
//
// The names are checked first, and the uploads are only tried once they are
// known to land on loopback, so this test itself can never send anything out.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const HOSTS = ['fppstats.falconchristmas.com', 'crashes.falconplayer.com'];
const LOG = '/tmp/fpp-tests-443.log';
const CRASH = '/home/fpp/media/crashes/fpp-Docker-10.x-fpp-tests-egress-2026-01-01_00-00-00.zip';

test('the statistics and crash servers resolve to loopback, and uploads land there', async ({ request }) => {
  for (const host of HOSTS) {
    const addrs = inPlayer('sh', '-c', `getent ahosts ${host} | awk '{print $1}' | sort -u`).split('\n').filter(Boolean);
    expect(addrs, `${host} resolves off the player`).toEqual(['127.0.0.1']);
  }

  // Records each connection to port 443 (the uploads are https), answers nothing.
  writeFile('/tmp/fpp-tests-443.py', `
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 443)); s.listen(8)
while True:
    c, _ = s.accept()
    open(sys.argv[1], 'a').write('connection\\n'); c.close()
`);
  inPlayer('sh', '-c', `rm -f ${LOG}; touch ${LOG}`);
  docker('exec', '-d', container, 'python3', '/tmp/fpp-tests-443.py', LOG);
  try {
    const listening = () => inPlayer('python3', '-c',
      "import socket\ntry:\n socket.create_connection(('127.0.0.1', 443), 1); print('yes')\nexcept OSError:\n print('no')").trim();
    await expect.poll(listening).toBe('yes');
    inPlayer('sh', '-c', `: > ${LOG}`);
    const connections = () => inPlayer('cat', LOG).split('\n').filter(Boolean).length;

    // A statistics upload, as fppd asks for one (setup left statistics on)
    expect(inPlayer('cat', '/home/fpp/media/settings')).toContain('statsPublish = "Enabled"');
    await request.post('/api/statistics/usage?force=1', { timeout: 30_000 });
    const afterStats = connections();
    expect(afterStats, 'the statistics upload went somewhere else').toBeGreaterThan(0);

    // A kept crash report sent from the player
    inPlayer('sh', '-c', `mkdir -p /home/fpp/media/crashes && printf 'PK\\005\\006%018d' 0 > ${CRASH}`);
    const sent = await (await request.post(`/api/crashes/upload/${CRASH.split('/').pop()}`, { timeout: 60_000 })).json();
    expect(sent.Status, JSON.stringify(sent)).toBe('Error');
    expect(connections(), 'the crash upload went somewhere else').toBeGreaterThan(afterStats);
  } finally {
    inPlayer('sh', '-c', `pkill -f "python3 /tmp/fpp-tests-443[.]py" || true; rm -f ${LOG} ${CRASH} /tmp/fpp-tests-443.py`);
  }
});

// GitHub's names are on loopback too, so the plugin manager, the update
// checks and the OS image list never ask the real GitHub; fake-https.ts
// serves the answers a test wants.  With nothing serving there, a request is
// refused at once instead of going out.
const GITHUB = ['github.com', 'www.github.com', 'api.github.com', 'codeload.github.com',
  'raw.githubusercontent.com', 'objects.githubusercontent.com'];

test('GitHub resolves to loopback, so nothing reaches the real GitHub', () => {
  for (const host of GITHUB) {
    const addrs = inPlayer('sh', '-c', `getent ahosts ${host} | awk '{print $1}' | sort -u`).split('\n').filter(Boolean);
    expect(addrs, `${host} resolves off the player`).toEqual(['127.0.0.1']);
  }
  const rc = inPlayer('sh', '-c', 'curl -s -o /dev/null --max-time 5 https://api.github.com/; echo $?').trim();
  expect(rc, 'curl to api.github.com should be refused on loopback').toBe('7');
});
