import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// nocc listens for mDNS answers for 500 ms, which a Wi-Fi access point can
// outlast by holding multicast back until its next beacon, so a Wi-Fi player
// found no build helpers.  fpp 94bc997e3 ("NOCC: add \"Enable NOCC discovery
// across Wireless Networks\" (off by default)") gives discovery
// NOCC_DISCOVER_TIMEOUT=3500ms when NoccDiscoverWireless is set.
//
// nocc-daemon is a stub here that answers with the timeout it was given.

const STUB_DIR = '/tmp/fpp-tests-nocc';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

function discover() {
  return inPlayer('bash', '-c',
    `export PATH=${STUB_DIR}:$PATH; . /opt/fpp/scripts/common; . /opt/fpp/scripts/functions; ` +
    `export PATH=${STUB_DIR}:$PATH; DiscoverNoccHosts`).trim();
}

test('wireless NOCC discovery waits longer for helpers', async ({ request }) => {
  inPlayer('sh', '-c', `mkdir -p ${STUB_DIR} && printf '#!/bin/sh\\necho "to-\${NOCC_DISCOVER_TIMEOUT:-unset}:1"\\n' > ${STUB_DIR}/nocc-daemon && chmod 755 ${STUB_DIR}/nocc-daemon`);
  try {
    // The control: the stub is the nocc-daemon found, with the default window.
    expect((await request.put('/api/settings/NoccDiscoverWireless', { data: '0' })).ok()).toBe(true);
    expect(discover()).toBe('to-unset:1');

    expect((await request.put('/api/settings/NoccDiscoverWireless', { data: '1' })).ok()).toBe(true);
    expect(discover()).toBe('to-3500ms:1');
  } finally {
    await request.put('/api/settings/NoccDiscoverWireless', { data: '0' });
    inPlayer('rm', '-rf', STUB_DIR);
  }
});
