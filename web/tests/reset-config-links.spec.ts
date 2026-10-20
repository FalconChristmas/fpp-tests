import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Reset Config's wildcard entries ("plugins/*") walked whatever they matched
// that is_dir() called a directory, and a link to a directory is one: a
// plugins folder kept on a USB stick or elsewhere had the files at the far
// end deleted, and the link was left.  Fixed in fpp f66cff5ac ("fix(security):
// Reset Config removes links, not what they point at").

const TARGET = '/tmp/fpp-tests-reset-target';
const LINK = '/home/fpp/media/plugins/fpp-tests-linked';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('resetting plugins removes a link, not what it points at', async ({ request }) => {
  inPlayer('sh', '-c', `mkdir -p ${TARGET} && echo keep > ${TARGET}/keep.txt && ln -sfn ${TARGET} ${LINK}`);
  try {
    const r = await request.get('/resetConfig.php?areas=plugins');
    expect(r.ok()).toBe(true);
    // The control: the reset ran over the plugins area and reached the link.
    expect(await r.text()).toContain('Area: plugins');
    expect(inPlayer('sh', '-c', `test -e ${TARGET}/keep.txt && echo kept || echo deleted`).trim(),
      'the reset deleted the files the link points at').toBe('kept');
    expect(inPlayer('sh', '-c', `test -L ${LINK} && echo link || echo gone`).trim()).toBe('gone');
  } finally {
    inPlayer('rm', '-rf', LINK, TARGET);
  }
});
