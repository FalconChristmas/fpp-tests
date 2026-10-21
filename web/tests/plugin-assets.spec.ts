import { test, expect } from './fixtures';
import { container } from './container';
import { PLUGINS, exists, sh, writeFile } from './plugin-backfill';

// A plugin's scripts, stylesheets and images are served from its own
// directory through plugin.php, at /js/plugin/<plugin>/<file>,
// /css/plugin/<plugin>/<file> and /images/plugin/<plugin>/<file>.  Those are
// URLs only: there is no www/js/plugin, www/css/plugin or www/images/plugin.
// Before d541e4ece their rewrites sat in <Directory> sections for those
// paths, which Apache applies only to a directory that exists, so js and css
// answered 404 (images worked only while a .gitkeep kept an empty directory
// in the tree, 0a86f3d63).

test.skip(!container, 'seeds a plugin inside the run-web.sh container');

const NAME = 'fpp-tests-assets';
const DIR = `${PLUGINS}/${NAME}`;

test.beforeEach(() => {
  sh(`rm -rf ${DIR}`);
  writeFile(`${DIR}/pluginInfo.json`, `{"name":"${NAME}","repoName":"${NAME}"}`);
  writeFile(`${DIR}/x.js`, 'var fppTestsJs = 1;\n');
  writeFile(`${DIR}/x.css`, '.fppTestsCss {}\n');
  writeFile(`${DIR}/x.png`, 'png\n');
  writeFile(`${DIR}/images/nested.png`, 'nested png\n');
});

test.afterEach(() => sh(`rm -rf ${DIR}`));

test('plugin js, css and images are served with no directory for them in the web root', async ({ request }) => {
  for (const [url, body] of [
    [`/js/plugin/${NAME}/x.js`, 'var fppTestsJs = 1;\n'],
    [`/css/plugin/${NAME}/x.css`, '.fppTestsCss {}\n'],
    [`/images/plugin/${NAME}/x.png`, 'png\n'],
    [`/images/plugin/${NAME}/images/nested.png`, 'nested png\n'],
  ]) {
    const r = await request.get(url);
    expect(r.status(), url).toBe(200);
    expect(await r.text(), url).toBe(body);
    expect(r.headers()['access-control-allow-origin'], url).toBe('*');
  }
  // And not because something made the directories.
  for (const d of ['js', 'css', 'images']) {
    expect(exists(`/opt/fpp/www/${d}/plugin`), `www/${d}/plugin exists`).toBe(false);
  }
});

test('a script, stylesheet or image of a plugin that is not installed is a 404', async ({ request }) => {
  // Regression: a111b72ac.  plugin.php answered a request naming no
  // installed plugin with 200 and the text "Plugin variable empty, please
  // don't access this page directly", so a page still loading a removed
  // plugin's script got that text as its script; a missing file of an
  // installed plugin was already a 404.
  // The control: the installed plugin's files are served.
  expect((await request.get(`/js/plugin/${NAME}/x.js`)).status()).toBe(200);
  for (const url of [
    '/js/plugin/fpp-tests-gone/x.js',
    '/css/plugin/fpp-tests-gone/x.css',
    '/images/plugin/fpp-tests-gone/x.png',
    '/plugin.php?plugin=fpp-tests-gone&file=x.js&nopage=1',
    '/plugin.php?plugin=fpp-tests-gone&page=x.php&nopage=1',
    '/plugin.php?plugin=..&file=x.js&nopage=1',
  ]) {
    const r = await request.get(url);
    expect(r.status(), url).toBe(404);
  }
});
