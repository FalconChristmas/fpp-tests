import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { exists, putFile, readFile } from './settings-file';

// Apache's port 80 listener on a player whose kernel has no IPv6 (booted with
// ipv6.disable=1, or without the ipv6 module).  The container's kernel has
// IPv6, so apache2ctl is run with noipv6.so preloaded (see noipv6.c): IPv6
// sockets can't be made and /proc/sys/net/ipv6 isn't there.  Only Apache's
// config test is run; the Apache serving the suite is left alone.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const PORTS = '/etc/apache2/ports.conf';
const ENVVARS = '/etc/apache2/envvars';
const SO = '/tmp/fpp-tests-noipv6.so';

// ports.conf as configure_apache() left it before the fix: Debian's, with the
// port 80 listener turned into the IPv6 wildcard.
const OLD_PORTS = `Listen [::]:80

<IfModule ssl_module>
\tListen 443
</IfModule>

<IfModule mod_gnutls.c>
\tListen 443
</IfModule>
`;

function configTest(noIPv6: boolean) {
  return inPlayer('sh', '-c', `${noIPv6 ? `LD_PRELOAD=${SO} ` : ''}apache2ctl -t 2>&1; echo rc=$?`);
}

// Regression: ea06e9e49.  With an unconditional "Listen [::]:80" Apache
// refused to start at all on such a kernel ("AH00078: alloc_listener: failed
// to get a socket for ::"), taking the whole web UI with it.  Upgrade 130
// gives an installed player a listener chosen by whether the kernel has IPv6
// (the way it chooses has changed since, in cc0cc1a04; what it gives must
// not).
test('after upgrade 130 Apache starts on a kernel without IPv6', async () => {
  const hadPorts = exists(PORTS);
  const savedPorts = hadPorts ? readFile(PORTS) : '';
  const savedEnv = readFile(ENVVARS);
  try {
    inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', SO, '/tests/web/tests/noipv6.c', '-ldl');
    putFile(PORTS, OLD_PORTS);
    // The control: the stand-in kernel really refuses the old listener, and
    // a kernel with IPv6 takes it.
    expect(configTest(true)).toContain('AH00078');
    expect(configTest(false)).toContain('rc=0');

    inPlayer('sh', '-c', 'bash /opt/fpp/upgrade/130/upgrade.sh > /dev/null 2>&1; true');
    const noV6 = configTest(true);
    expect(noV6, `Apache's config test fails without IPv6:\n${readFile(PORTS)}`).toContain('rc=0');
    expect(noV6).not.toContain('AH00078');
    expect(configTest(false)).toContain('rc=0');
  } finally {
    if (hadPorts) putFile(PORTS, savedPorts);
    putFile(ENVVARS, savedEnv);
    inPlayer('rm', '-f', SO);
  }
});
