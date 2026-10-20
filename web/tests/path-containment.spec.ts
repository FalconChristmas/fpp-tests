import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The file and config-file endpoints checked a resolved path with
// strpos($path, $base) === 0, which a sibling directory also passes:
// <media>/config-old starts with <media>/config.  Reaching one takes a link
// under the base -- the case the check exists for.  Fixed in fpp 98e2cd9ae
// ("fix(api): path containment checks no longer let a sibling directory
// through").

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a link to a sibling of a served directory is refused', async ({ request }) => {
  const media = inPlayer('readlink', '-f', '/home/fpp/media').trim();
  inPlayer('sh', '-c',
    `mkdir -p ${media}/config-old ${media}/music-old && ` +
    `echo '{"fppTests": "secret"}' > ${media}/config-old/secret.json && echo keep > ${media}/music-old/a.txt && ` +
    `ln -sfn ../config-old ${media}/config/sib && ln -sfn ../music-old ${media}/music/sib`);
  try {
    // The control: a file really in the directory is served.
    inPlayer('sh', '-c', `echo ok > ${media}/music/fpp-tests-inside.txt`);
    expect(await (await request.get('/api/file/music/fpp-tests-inside.txt')).text()).toContain('ok');

    const cfg = await request.get('/api/configfile/sib/secret.json');
    expect(await cfg.text()).not.toContain('secret');
    expect(cfg.status()).toBe(403);

    const get = await request.get('/api/file/music/sib/a.txt');
    expect(await get.text()).not.toContain('keep');
    expect(get.status()).toBe(403);

    await request.delete('/api/file/music/sib/a.txt');
    expect(inPlayer('sh', '-c', `test -e ${media}/music-old/a.txt && echo kept || echo deleted`).trim()).toBe('kept');
  } finally {
    inPlayer('rm', '-rf', `${media}/config/sib`, `${media}/music/sib`, `${media}/config-old`, `${media}/music-old`,
      `${media}/music/fpp-tests-inside.txt`);
  }
});
