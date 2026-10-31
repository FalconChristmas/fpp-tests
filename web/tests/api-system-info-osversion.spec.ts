import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// GET /api/system/info reports the OS image version with the word size of
// the PHP that answered, as "<rfs_version> (64bit)" (Feature: 8ca11cdfd):
// the 32-bit and 64-bit images of one release carry the same version.

test.skip(!container, 'moves the container marker aside inside the run-web.sh container');

const CONTAINER = '/etc/fpp/container';
const ASIDE = '/etc/fpp/container.fpp-tests-aside';
const RFS = '/etc/fpp/rfs_version';

test('OSVersion is the image version with the PHP word size', async ({ request }) => {
  const hadRfs = inPlayer('sh', '-c', `test -e ${RFS} && cat ${RFS} || true`);
  inPlayer('sh', '-c', `printf 'fpp-tests-2026.01' > ${RFS}`);
  inPlayer('mv', CONTAINER, ASIDE);
  try {
    const info = await (await request.get('/api/system/info')).json();
    const bits = inPlayer('php', '-r', 'echo PHP_INT_SIZE === 8 ? "64bit" : "32bit";').trim();
    expect(info.OSVersion).toBe(`fpp-tests-2026.01 (${bits})`);
  } finally {
    inPlayer('mv', ASIDE, CONTAINER);
    inPlayer('sh', '-c', hadRfs ? `printf '%s' '${hadRfs}' > ${RFS}` : `rm -f ${RFS}`);
  }
});
