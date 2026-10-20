import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// IsRemotePeerHost() (fpp bf82a9e3e) judges a MultiSync peer name by the
// addresses it resolves to, but curl then resolved the name again for the
// request itself.  A name with a short TTL could answer a LAN address to the
// check and 127.0.0.1 to curl (DNS rebinding), and the job reached the player
// itself, where Apache treats the request as local.  Regression: 177fb0af6
// ("fix(security): requests to a MultiSync peer go to the addresses it was
// judged by").
//
// The rebinding is staged inside the player: getent, which the check runs,
// answers an unreachable TEST-NET address for the name, while /etc/hosts,
// which curl reads, maps it to loopback.

const NAME = 'fpp-tests-rebind.example';
const FILE = 'fpp-tests-rebind.txt';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a job goes to the address its peer name was judged by', async ({ request }) => {
  inPlayer('sh', '-c',
    'cp /etc/hosts /tmp/fpp-tests-hosts && echo "127.0.0.1 ' + NAME + '" >> /etc/hosts && ' +
    'mv /usr/bin/getent /usr/bin/getent.fpp-tests && ' +
    'printf \'#!/bin/sh\\nif [ "$2" = "' + NAME + '" ]; then echo "192.0.2.1       STREAM ' + NAME + '"; exit 0; fi\\n' +
    'exec /usr/bin/getent.fpp-tests "$@"\\n\' > /usr/bin/getent && chmod 755 /usr/bin/getent');
  const up = await request.post(`/api/file/Uploads/${FILE}`, { data: 'fpp-tests' });
  expect(up.ok()).toBe(true);
  try {
    // The control: the check and curl really do disagree about the name.
    expect(inPlayer('getent', 'ahosts', NAME)).toContain('192.0.2.1');
    expect(inPlayer('curl', '-s', '-o', '/dev/null', '-w', '%{remote_ip}', `http://${NAME}/`)).toBe('127.0.0.1');

    const r = await request.post('/streamRemoteJobs.php', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ jobs: [{ id: 'r', type: 'pushFiles', ip: NAME, dir: 'uploads', files: [FILE] }] }),
      timeout: 60_000,
    });
    const body = await r.text();
    expect(body).toContain(`to ${NAME}...`);
    expect(body).not.toContain('Complete:');
    expect(body).toContain(`ERROR sending ${FILE}`);
  } finally {
    inPlayer('sh', '-c', 'mv /usr/bin/getent.fpp-tests /usr/bin/getent; cat /tmp/fpp-tests-hosts > /etc/hosts');
    await request.delete(`/api/file/Uploads/${FILE}`);
  }
});
