import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Regression: 1f43d6489 ("Fix some apache errors if not pixel capes are
// found").  co-pixelStrings.php read $capes[0] without checking there was a
// cape; on a Beagle or Pi with no pixel cape each Channel Outputs page load
// logged PHP warnings (and with display_errors on, wrote them into the
// page's script), and the default output had no pinoutVersion.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const PLATFORM = '/etc/fpp/platform';
const INFO = '/home/fpp/media/tmp/cape-info.json';
let savedPlatform = '';
let savedInfo: string | null = null;

test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  const out = inPlayer('sh', '-c', `if [ -e ${INFO} ]; then echo yes; cat ${INFO}; else echo no; fi`);
  savedInfo = out.startsWith('yes\n') ? out.slice(4) : null;
  // A Beagle gets the Pixel Strings tab; nothing in the container is a cape.
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > ${PLATFORM}; rm -f ${INFO}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  if (savedInfo !== null) inPlayer('sh', '-c', `printf '%s' '${savedInfo.replace(/'/g, "'\\''")}' > ${INFO}`);
});

test('the pixel strings tab with no pixel cape sets a default pinout and raises no PHP warning', async ({ request }) => {
  // PHP's display_errors is off, so the warnings land in Apache's error log.
  const LOG = '/home/fpp/media/logs/apache2-error.log';
  const logged = () => Number(inPlayer('sh', '-c', `wc -c < ${LOG} 2>/dev/null || echo 0`).trim());
  const from = logged();
  const r = await request.get('/channeloutputs.php');
  expect(r.ok()).toBe(true);
  const body = await r.text();
  expect(body, 'the pixel strings tab rendered').toContain('function loadPixelStringOutputs');
  const added = inPlayer('sh', '-c', `tail -c +${from + 1} ${LOG} 2>/dev/null || true`);
  expect(added, 'PHP logged warnings reading the missing cape').not.toMatch(/Undefined (array key|offset|index)/);
  expect(body).toContain('output.pinoutVersion = "1.x";');
});
