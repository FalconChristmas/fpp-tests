import { test, expect } from './fixtures';
import { container } from './container';
import { PLUGINS, sh } from './plugin-repo';
import { buildNativePlugin } from './native-plugin';

// The API page (Help > REST API: /api/, which frames the Scalar viewer in
// /api/api.html) and the OpenAPI spec it shows, /api/openapi.json, which
// www/api builds from the shipped openapi.json, the plugins' own routes and
// what fppd reports it serves.

async function spec(request: any): Promise<any> {
  const r = await request.get('/api/openapi.json');
  expect(r.status(), `GET /api/openapi.json: ${(await r.text()).slice(0, 300)}`).toBe(200);
  return r.json();
}

function writeIn(path: string, content: string) {
  const b64 = Buffer.from(content).toString('base64');
  sh(`mkdir -p "$(dirname '${path}')" && echo '${b64}' | base64 -d > '${path}'`);
}

test('the API page is served at /api/, with its spec, and a cross-origin client may send a JSON body', async ({ request }) => {
  // Regression: f4e282bb2.  /api/ is a directory, which the "not a file or
  // directory" conditions kept from reaching index.php's route for the docs
  // page, and the page's PHP included ../config.php relative to the wrong
  // directory; and the CORS headers did not allow Content-Type, so another
  // site's request with a JSON body failed its preflight.
  // Also f069df061: the spec is built from the shipped openapi.json (it was
  // openapi.yaml); without that file the served spec has no openapi version.
  const page = await request.get('/api/');
  expect(page.status(), (await page.text()).slice(0, 500)).toBe(200);
  expect(await page.text()).toContain('/api/api.html');
  const viewer = await request.get('/api/api.html');
  expect(viewer.status()).toBe(200);
  expect(await viewer.text()).toContain('/api/openapi.json');
  expect((await spec(request)).openapi).toMatch(/^3\./);

  // From 74eb6743f on the CORS headers are sent only while other websites
  // are allowed to read the API; before it they always were.
  try {
    expect((await request.put('/api/settings/AllowCrossOriginAPI', { data: '1' })).ok()).toBe(true);
    const r = await request.get('/api/time', { headers: { Origin: 'http://elsewhere.example' } });
    expect(r.status()).toBe(200);
    // The control: this is a cross-origin answer.
    expect(r.headers()['access-control-allow-origin']).toBe('*');
    expect(r.headers()['access-control-allow-headers'] ?? '', 'Access-Control-Allow-Headers').toMatch(/content-type/i);
  } finally {
    await request.put('/api/settings/AllowCrossOriginAPI', { data: '0' });
  }
});

test.describe('with a plugin', () => {
  test.skip(!container, 'puts plugin directories inside the run-web.sh container');

  test("the spec is built live: it lists a plugin's endpoint, and fppd's AES67 and Opus status are served where it says", async ({ request }) => {
    // Feature: 3a9a29ea2.  Apache served www/api/openapi.json as a static
    // file, so ServeOpenApiSpec(), which adds the plugins' endpoints, was
    // never reached; GET /api/aes67 and /api/opusrtp were not proxied to
    // fppd at all; and fppd's new route list is kept out of the
    // /api/plugin-apis/ passthrough.
    const NAME = 'fpp-tests-docs-live';
    try {
      writeIn(`${PLUGINS}/${NAME}/api.php`, `<?php
function getEndpointsfpptestsdocslive() {
    return array(array('method' => 'GET', 'endpoint' => 'hello', 'callback' => 'fppTestsDocsLiveHello'));
}
function fppTestsDocsLiveHello() { return 'fpp-tests docs plugin'; }
`);
      const s = await spec(request);
      expect(Object.keys(s.paths).filter((p) => p.includes(NAME)), "the plugin's endpoint in the spec").not.toEqual([]);

      for (const path of ['/api/aes67', '/api/opusrtp']) {
        expect(s.paths[path]?.get, `${path} in the spec`).toBeTruthy();
        const r = await request.get(path);
        expect(r.status(), `GET ${path}: ${(await r.text()).slice(0, 200)}`).toBe(200);
        expect(typeof (await r.json()).active, `${path} is fppd's status`).toBe('boolean');
      }

      expect((await request.get('/api/plugin-apis/internal/pluginApiRoutes')).status()).toBe(403);
      // The control: the passthrough itself reaches fppd.
      expect((await request.get('/api/plugin-apis/fppd/version')).status()).toBe(200);
    } finally {
      sh(`rm -rf '${PLUGINS}/${NAME}'`);
    }
  });

  test("the spec lists none of fppd's internal routes, which Apache refuses", async ({ request }) => {
    // Regression: fpp a1e516e8e.  fppd's route list (/internal/pluginApiRoutes)
    // includes its internal routes, and only that one was left out of the
    // spec, by name: POST /api/plugin-apis/internal/crashReport was listed as
    // undocumented, though Apache answers every /api/plugin-apis/internal
    // path 403.
    const routes = JSON.parse(sh('curl -s http://localhost:32322/internal/pluginApiRoutes'));
    // The controls: fppd does report another internal route, and Apache does
    // refuse it.
    expect(routes.map((r: any) => r.path), 'fppd reports /internal/crashReport').toContain('/internal/crashReport');
    expect((await request.post('/api/plugin-apis/internal/crashReport', { data: '' })).status()).toBe(403);

    const s = await spec(request);
    expect(Object.keys(s.paths).filter((p) => /\/internal(\/|$)/i.test(p))).toEqual([]);
  });

  test("a plugin documents its own routes with apiDocs.json, and a broken one is skipped", async ({ request }) => {
    // Feature: 006f389dc.  A plugin's apiDocs.json (an OpenAPI "paths"
    // fragment, keyed by the path the plugin registers with fppd) is merged
    // into the spec under the external path, tagged with the plugin; one
    // that is not such a fragment is logged and skipped, and the spec still
    // serves.  It also documents the runtime plugin load/unload route under
    // readable names, dropping the positional {1}/{2} form fppd reports.
    const DOCS = 'fpp-tests-docs-own';
    const BROKEN = 'fpp-tests-docs-broken';
    const WRONG = 'fpp-tests-docs-wrong';
    try {
      writeIn(`${PLUGINS}/${DOCS}/apiDocs.json`, JSON.stringify({
        paths: {
          '/fppTestsDocs/status': { get: { summary: 'fpp-tests documented route' } },
          '/fppd/fppTestsDocs': { post: { summary: 'fpp-tests direct route' } },
          // Under fppd's internal namespace, which Apache refuses (fpp a1e516e8e).
          '/Internal/fppTestsDocs': { get: { summary: 'fpp-tests internal route' } },
        },
      }));
      writeIn(`${PLUGINS}/${BROKEN}/apiDocs.json`, '{ "paths": { "/fppTestsBroken": ');
      writeIn(`${PLUGINS}/${WRONG}/apiDocs.json`, JSON.stringify({ paths: ['/fppTestsWrong'] }));

      const s = await spec(request);
      const own = s.paths['/api/plugin-apis/fppTestsDocs/status']?.get;
      expect(own, JSON.stringify(Object.keys(s.paths).filter((p) => /fppTests/i.test(p)))).toBeTruthy();
      expect(own.summary).toBe('fpp-tests documented route');
      expect(own.tags).toEqual(['Plugins', DOCS]);
      expect(Object.keys(own.responses ?? {})).toContain('200');
      // A path in a namespace Apache proxies directly is listed there.
      expect(s.paths['/api/fppd/fppTestsDocs']?.post?.summary).toBe('fpp-tests direct route');
      expect(JSON.stringify(s)).not.toContain('fppTestsWrong');
      expect(JSON.stringify(s), 'a plugin path under /internal/').not.toContain('fpp-tests internal route');

      expect(s.paths['/api/fppd/plugin/{PluginName}/{action}']?.post, 'the plugin load/unload route').toBeTruthy();
      expect(Object.keys(s.paths).filter((p) => /\{\d+\}/.test(p)), 'positional path parameters').toEqual([]);
    } finally {
      sh(`rm -rf '${PLUGINS}/${DOCS}' '${PLUGINS}/${BROKEN}' '${PLUGINS}/${WRONG}'`);
    }
  });
  test("a compiled plugin's route is in the spec where it answers: undocumented, then as its apiDocs.json says", async ({ request }) => {
    // The receiving end of 3a9a29ea2 and 006f389dc: a route a C++ plugin
    // registers with fppd (tools/lateroutesplugin.cpp's GET /late/ok, loaded
    // at runtime) is listed under "Undocumented" at
    // /api/plugin-apis/late/ok, and a GET there reaches the plugin; once the
    // plugin ships an apiDocs.json, the same path carries its description.
    // Runtime loading arrived after 3a9a29ea2 (07f19dda1), so only the
    // apiDocs half can run on a parent: 006f389dc's.
    test.setTimeout(240_000);
    const NAME = 'fpp-late';
    const PATH = '/api/plugin-apis/late/ok';
    try {
      buildNativePlugin('lateroutesplugin.cpp', NAME);
      const load = await request.post(`/api/fppd/plugin/${NAME}/load`, { data: {}, timeout: 60_000 });
      expect(load.ok(), await load.text()).toBe(true);
      const answer = await request.get(PATH);
      expect(answer.status(), `GET ${PATH}`).toBe(200);
      expect(await answer.text()).toBe('ok');

      let op = (await spec(request)).paths[PATH]?.get;
      expect(op, `${PATH} in the spec`).toBeTruthy();
      expect(op.tags).toEqual(['Undocumented']);

      writeIn(`${PLUGINS}/${NAME}/apiDocs.json`, JSON.stringify({
        paths: { '/late/ok': { get: { summary: 'fpp-tests late route' } } },
      }));
      op = (await spec(request)).paths[PATH]?.get;
      expect(op?.summary, `${PATH} in the spec`).toBe('fpp-tests late route');
      expect(op.tags).toEqual(['Plugins', NAME]);
    } finally {
      await request.post(`/api/fppd/plugin/${NAME}/unload`, { data: {}, timeout: 60_000 });
      sh(`rm -rf '${PLUGINS}/${NAME}'`);
    }
  });
});

test('the spec lists Recurring Tasks where fppd serves them', async ({ request }) => {
  // Regression: ce38a6b7b, with the spec regenerated in 593ad277a.  The
  // docblocks said /api/recurringtasks, which nothing serves, so the API
  // page sent GET and POST there and got 404; fppd's handler and the
  // Recurring Tasks page use /api/fppd/recurringtasks.
  const s = await spec(request);
  const paths = Object.keys(s.paths).filter((p) => /recurringtasks/i.test(p));
  expect(paths).toEqual(['/api/fppd/recurringtasks']);
  expect(s.paths[paths[0]].get).toBeTruthy();
  expect(s.paths[paths[0]].post).toBeTruthy();
  const r = await request.get(paths[0]);
  expect(r.status()).toBe(200);
  expect(Array.isArray((await r.json()).tasks), 'the recurring tasks').toBe(true);
});

test("the API page's copy buttons work where the browser has no clipboard API", async ({ page }) => {
  // Regression: ac12b0b61.  navigator.clipboard exists only in a secure
  // context (HTTPS or localhost), and a player is reached over plain HTTP on
  // its LAN address, where it is undefined.  Scalar's "Copy link" calls
  // navigator.clipboard.writeText() with no fallback, so it said "Failed to
  // copy to clipboard"; api.html now supplies one through execCommand('copy').
  // The test reaches the player on 127.0.0.1, which is a secure context, so
  // it takes the clipboard API away as such a page would not have it, and
  // records what execCommand('copy') copies.
  await page.addInitScript(() => {
    delete (Navigator.prototype as any).clipboard;
    (window as any).__copied = [];
    const exec = document.execCommand.bind(document);
    document.execCommand = (cmd: string, ...rest: any[]) => {
      if (cmd === 'copy') {
        const el = document.activeElement as HTMLTextAreaElement | null;
        (window as any).__copied.push(el && 'value' in el ? el.value : String(getSelection()));
      }
      return exec(cmd, ...rest);
    };
  });
  await page.goto('/api/api.html');
  const copy = page.getByRole('button', { name: 'Copy link' }).first();
  await copy.waitFor({ timeout: 30_000 });
  // The control: the page really has no clipboard API.
  expect(await page.evaluate(() => typeof (Navigator.prototype as any).clipboard)).toBe('undefined');
  await copy.click();
  // Scalar's toast (an <li>), whichever it says.
  const toast = page.locator('li').filter({ hasText: /Copied to the clipboard|Failed to copy/i });
  await expect(toast.first()).toBeAttached({ timeout: 10_000 });
  expect([...new Set((await toast.allTextContents()).map((t) => t.trim()))]).toEqual(['Copied to the clipboard']);
  const copied: string[] = await page.evaluate(() => (window as any).__copied);
  expect(copied.length, 'execCommand(copy) calls').toBe(1);
  expect(copied[0]).toMatch(/^https?:\/\/[^/]+\/api\/api\.html#/);
});
