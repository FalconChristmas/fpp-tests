import { test, expect } from './fixtures';
import { container, inPlayer, playerAddress } from './container';

// IsRemotePeerHost() (fpp 307566ca3) keeps a caller-supplied MultiSync peer
// off loopback, but judged only literal IP addresses: 127.1, 2130706433 and
// 0x7f000001 (and 0177.0.0.1 with glibc) failed FILTER_VALIDATE_IP, passed
// the host-name pattern, and curl resolved every one to 127.0.0.1, as it does
// ip6-localhost through /etc/hosts.  A file push job aimed at one reached the
// player itself.  Regression: bf82a9e3e ("fix(security): judge a MultiSync
// peer name by the addresses it resolves to").

const SPELLINGS = ['127.1', '2130706433', '0x7f000001', '0177.0.0.1', 'ip6-localhost', '0'];

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a job is refused a loopback address spelled as a host name', async ({ request }) => {
  const up = await request.post('/api/file/Uploads/fpp-tests-loopback.txt', { data: 'fpp-tests' });
  expect(up.ok()).toBe(true);
  // The control: the player's own LAN address, which MultiSync uses for its
  // own row, is still pushed to.
  const own = playerAddress().ip;
  try {
    const jobs = [...SPELLINGS, own].map((ip, i) => ({ id: `l${i}`, type: 'pushFiles', ip, dir: 'uploads', files: ['fpp-tests-loopback.txt'] }));
    const r = await request.post('/streamRemoteJobs.php', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ jobs }),
      timeout: 60_000,
    });
    const body = await r.text();
    expect(body).toContain(`to ${own}...`);
    const reached = SPELLINGS.filter((ip) => body.includes(`to ${ip}...`));
    expect(reached, body).toEqual([]);
  } finally {
    await request.delete('/api/file/Uploads/fpp-tests-loopback.txt');
  }
});

// The name is resolved before the job runs, and a lookup that never answers
// must not hold the request for the resolver's retries (10 s and more): it is
// cut off and the name refused.  The player's DNS server is pointed at an
// address that never answers for the length of the test.
test('a name that never resolves is refused quickly', async ({ request }) => {
  inPlayer('sh', '-c', 'cp /etc/resolv.conf /tmp/fpp-tests-resolv.conf && printf "nameserver 192.0.2.1\\noptions timeout:5 attempts:2\\n" > /etc/resolv.conf');
  try {
    // The control: a lookup of it does hang.
    expect(inPlayer('sh', '-c', 'timeout 4 getent ahosts fpp-tests-hang.example; echo "rc=$?"').trim()).toBe('rc=124');
    const started = Date.now();
    const r = await request.post('/streamRemoteJobs.php', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ jobs: [{ id: 'h', type: 'pushFiles', ip: 'fpp-tests-hang.example', dir: 'uploads', files: ['x'] }] }),
      timeout: 60_000,
    });
    const body = await r.text();
    expect(body).toContain('invalid host');
    expect(Date.now() - started, body).toBeLessThan(8_000);
  } finally {
    inPlayer('sh', '-c', 'cat /tmp/fpp-tests-resolv.conf > /etc/resolv.conf');
  }
});
