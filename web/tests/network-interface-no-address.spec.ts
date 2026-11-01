import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// An interface that has no hardware address (a tunnel, a ppp or point-to-point
// link: `ip --json address show` leaves out "address" for it) must list like
// any other.
//
// Regression: a8598939d ("Fix displaying stats with interfaces that don't
// have address").  The interface list read $rec["address"] unchecked, so the
// first such interface put an "Undefined array key" warning into the
// interface API's reply and the usage statistics.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const TUN = '{"ifindex":99,"ifname":"fpptun0","flags":["POINTOPOINT","UP","LOWER_UP"],"mtu":1400,"operstate":"UNKNOWN",' +
  '"link_type":"none","addr_info":[{"family":"inet","local":"192.0.2.9","prefixlen":32,"scope":"global","label":"fpptun0"}]}';

let real = '';
test.beforeAll(() => {
  // PHP runs ip by absolute path (/usr/sbin first); put a stand-in over the
  // real one that adds the tunnel to the JSON list and passes everything else on.
  real = inPlayer('sh', '-c', 'readlink -f "$(command -v ip)"').trim();
  inPlayer('sh', '-c', `cp -a ${real} ${real}.fpp-tests && ` +
    `printf '%s\\n' '#!/bin/sh' 'case "$*" in *"--json address show"*) ${real}.fpp-tests "$@" | sed '"'"'s/\\]$/,${TUN}]/'"'"' ;; *) exec ${real}.fpp-tests "$@" ;; esac' > ${real}.stub && ` +
    `chmod 755 ${real}.stub && mv ${real}.stub ${real}`);
});
test.afterAll(() => {
  if (real) inPlayer('sh', '-c', `mv -f ${real}.fpp-tests ${real}`);
});

test('an interface without a hardware address is listed without a PHP warning', async ({ request }) => {
  // The reply can't show it: the API's error handler swallows warnings.  So
  // the list is built in a PHP of its own, warnings on, as the API builds it.
  const out = inPlayer('php', '-d', 'display_errors=1', '-d', 'html_errors=0', '-d', 'error_reporting=-1', '-r',
    '$skipJSsettings = 1; chdir("/opt/fpp/www"); require_once "/opt/fpp/www/common.php"; ' +
    'echo "LIST:" . json_encode(array_column(network_list_interfaces_obj(), "ifname"));');
  // The control: the stand-in's tunnel is in the list.
  const m = /LIST:(\[.*\])/.exec(out);
  expect(m, out).toBeTruthy();
  expect(JSON.parse(m![1])).toContain('fpptun0');
  expect(out.replace(/LIST:.*/, ''), 'a PHP warning building the list').not.toMatch(/Undefined|Warning|Notice/);
  // And the API serves it.
  const r = await request.get('/api/network/interface');
  expect((await r.json()).map((i: any) => i.ifname)).toContain('fpptun0');
});
