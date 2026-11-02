import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, setSettingInFile, snapshotSettings } from './settings-file';

// The mail relay's login when the smarthost name is an alias.  exim looks the
// credentials up under the name of the server it actually connects to, which
// is the CNAME's target.  The player's resolver is pointed at a name server
// run inside the container for the test, which answers for two names.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const STUB = '/tmp/fpp-tests-dns.php';
const PIDFILE = '/tmp/fpp-tests-dns.pid';
const QUERIES = '/tmp/fpp-tests-dns.queries';
const STUB_SRC = `<?php
// A DNS server on 127.0.0.1:53: mail.fpp-tests.test is a CNAME for
// relay.fpp-tests.test; plain.fpp-tests.test has no CNAME.  Each query is
// logged as "<name> <type>".
$s = stream_socket_server('udp://127.0.0.1:53', $errno, $errstr, STREAM_SERVER_BIND);
if (!$s) { fwrite(STDERR, "$errstr\\n"); exit(1); }
file_put_contents('${PIDFILE}', getmypid());
while (true) {
    $q = stream_socket_recvfrom($s, 512, 0, $peer);
    if ($q === false || strlen($q) < 17) continue;
    $i = 12; $labels = array();
    while ($i < strlen($q) && ord($q[$i]) > 0) { $n = ord($q[$i]); $labels[] = substr($q, $i + 1, $n); $i += $n + 1; }
    $name = strtolower(implode('.', $labels));
    $qend = $i + 5;
    $type = unpack('n', substr($q, $i + 1, 2))[1];
    file_put_contents('${QUERIES}', "$name $type\\n", FILE_APPEND);
    $answer = '';
    $count = 0;
    if ($name === 'mail.fpp-tests.test' && $type == 5) {
        $rdata = '';
        foreach (array('relay', 'fpp-tests', 'test') as $l) $rdata .= chr(strlen($l)) . $l;
        $rdata .= chr(0);
        $answer = "\\xc0\\x0c" . pack('nnNn', 5, 1, 60, strlen($rdata)) . $rdata;
        $count = 1;
    }
    $resp = substr($q, 0, 2) . pack('nnnnn', 0x8180, 1, $count, 0, 0) . substr($q, 12, $qend - 12) . $answer;
    stream_socket_sendto($s, $resp, 0, $peer);
}
`;

const RESOLV = '/etc/resolv.conf';
const SAVED_RESOLV = '/tmp/fpp-tests-resolv.conf.cname';

async function configure(request: any, server: string) {
  setSettingInFile('emailserver', server);
  setSettingInFile('emailport', '587');
  setSettingInFile('emailuser', 'fpp-tests-user');
  setSettingInFile('emailpass', 'fpp-tests-pass');
  setSettingInFile('emailtoemail', 'fpp-tests@example.com');
  const r = await request.post('/api/email/configure');
  expect(r.ok(), await r.text()).toBe(true);
  return readFile(`${MEDIA}/exim4/passwd.client`).split('\n').filter((l: string) => l && !l.startsWith('#'));
}

test('a smarthost that is a CNAME also gets its login under the real server name', async ({ request }) => {
  // Regression: bccb9d957.  The login was written only under the name the
  // user typed; exim authenticates against the name it connected to, the
  // CNAME's target, found no entry, and mail through the relay was refused.
  const restore = snapshotSettings();
  const staged = `${MEDIA}/exim4`;
  const hadStaged = exists(staged);
  const hadExim = exists('/etc/exim4');
  const hadAliases = exists('/etc/aliases');
  const hadAddresses = exists('/etc/email-addresses');
  inPlayer('mkdir', '-p', staged, '/etc/exim4');
  inPlayer('sh', '-c', `cp ${RESOLV} ${SAVED_RESOLV}`);
  putFile(STUB, STUB_SRC);
  inPlayer('rm', '-f', PIDFILE, QUERIES);
  docker('exec', '-d', container, 'php', STUB);
  try {
    for (let i = 0; i < 50 && !exists(PIDFILE); i++) await new Promise((r) => setTimeout(r, 100));
    expect(exists(PIDFILE), 'the name server did not start').toBe(true);
    inPlayer('sh', '-c', `printf 'nameserver 127.0.0.1\\noptions timeout:2 attempts:1\\n' > ${RESOLV}`);

    expect(await configure(request, 'mail.fpp-tests.test')).toEqual([
      'mail.fpp-tests.test:fpp-tests-user:fpp-tests-pass',
      'relay.fpp-tests.test:fpp-tests-user:fpp-tests-pass',
    ]);
    // What exim reads is what FPP installed from that.
    expect(readFile('/etc/exim4/passwd.client')).toContain('relay.fpp-tests.test:fpp-tests-user:fpp-tests-pass');
    // The control: the name server was asked for a CNAME (type 5), and a
    // server with none gets the one line.
    expect(readFile(QUERIES)).toContain('mail.fpp-tests.test 5');
    expect(await configure(request, 'plain.fpp-tests.test')).toEqual(['plain.fpp-tests.test:fpp-tests-user:fpp-tests-pass']);
  } finally {
    inPlayer('sh', '-c', `cat ${SAVED_RESOLV} > ${RESOLV}; rm -f ${SAVED_RESOLV}; [ -f ${PIDFILE} ] && kill $(cat ${PIDFILE}); rm -f ${STUB} ${PIDFILE} ${QUERIES}; true`);
    restore();
    if (!hadStaged) inPlayer('rm', '-rf', staged);
    if (!hadExim) inPlayer('rm', '-rf', '/etc/exim4');
    if (!hadAliases) inPlayer('rm', '-f', '/etc/aliases');
    if (!hadAddresses) inPlayer('rm', '-f', '/etc/email-addresses');
  }
});
