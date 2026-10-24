import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { PLUGINS, sh } from './plugin-repo';

// A plugin's api.php: www/api/index.php require_once's every installed
// plugin's api.php on every API request, before limonade dispatches it, and
// registers the endpoints its getEndpoints<name>() returns under
// /api/plugin/<name>/<endpoint>.  So one plugin's file is in the path of every
// route FPP serves; these check that a bad one costs only its own endpoints.

test.skip(!container, 'puts plugin directories inside the run-web.sh container');

// Writes plugins/<name>/api.php (through base64, so no quoting can bite).
function plugin(name: string, php: string) {
  const b64 = Buffer.from(php).toString('base64');
  sh(`mkdir -p '${PLUGINS}/${name}' && echo '${b64}' | base64 -d > '${PLUGINS}/${name}/api.php'`);
}

function removePlugins(...names: string[]) {
  sh(`rm -rf ${names.map((n) => `'${PLUGINS}/${n}'`).join(' ')}`);
}

// FPP's own PHP routes still answer, with JSON: GET /api/time (GetTime() in
// controllers/settings.php) and the plugin list (controllers/plugin.php).
async function fppApiAnswers(request: APIRequestContext) {
  for (const [path, member] of [['/api/time', 'time'], ['/api/plugin', null]] as const) {
    const r = await request.get(path);
    const text = await r.text();
    expect(r.status(), `GET ${path}: ${text.slice(0, 300)}`).toBe(200);
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* reported below */ }
    expect(body, `GET ${path} is not JSON: ${text.slice(0, 300)}`).not.toBeNull();
    if (member) expect(body[member], path).toBeTruthy();
  }
}

// A well-behaved plugin next to the broken one, whose endpoint must keep
// working.
const GOOD = 'fpp-tests-api-good';
const goodPlugin = () => plugin(GOOD, `<?php
function getEndpointsfpptestsapigood() {
    return array(array('method' => 'GET', 'endpoint' => 'hello', 'callback' => 'fppTestsApiGoodHello'));
}
function fppTestsApiGoodHello() { return 'fpp-tests good plugin'; }
`);

async function goodPluginAnswers(request: APIRequestContext) {
  const r = await request.get(`/api/plugin/${GOOD}/hello`);
  expect(r.status(), `GET /api/plugin/${GOOD}/hello`).toBe(200);
  expect(await r.text()).toContain('fpp-tests good plugin');
}

test("a plugin's endpoints register from a getEndpoints function not named after its directory, and one with none is skipped", async ({ request }) => {
  // Regression: 868444c97.  The endpoints came only from
  // call_user_func("getEndpoints<directory name without dashes>"); a plugin
  // whose function had another name, or that had none, made that call throw
  // and every API route answered 500.  Now the function is found among the
  // ones the file declared, and a plugin without one is skipped.
  const ODD = 'fpp-tests-api-oddname';
  const NONE = 'fpp-tests-api-none';
  try {
    plugin(ODD, `<?php
function getEndpointsOddNamedPlugin() {
    return array(array('method' => 'GET', 'endpoint' => 'hello', 'callback' => 'fppTestsApiOddHello'));
}
function fppTestsApiOddHello() { return 'fpp-tests odd-named plugin'; }
`);
    plugin(NONE, `<?php
function fppTestsApiNoneHelper() { return 1; }
`);
    await fppApiAnswers(request);
    const r = await request.get(`/api/plugin/${ODD}/hello`);
    expect(r.status(), `GET /api/plugin/${ODD}/hello: ${(await r.text()).slice(0, 300)}`).toBe(200);
    expect(await r.text()).toContain('fpp-tests odd-named plugin');
  } finally {
    removePlugins(ODD, NONE);
  }
});

test("a plugin's api.php declaring a function FPP's API has is skipped, and the API keeps working", async ({ request }) => {
  // Regression: 89e94765e.  Plugins' api.php files were loaded before FPP's
  // own controllers, so one declaring GetTime() (as controllers/settings.php
  // does) made loading the controllers a "Cannot redeclare" fatal error, and
  // every route in the API answered 500.  Now the controllers load first and a
  // plugin declaring one of their names is skipped, losing only its own
  // endpoints.
  const CLASH = 'fpp-tests-api-clash';
  try {
    plugin(CLASH, `<?php
function getEndpointsfpptestsapiclash() {
    return array(array('method' => 'GET', 'endpoint' => 'hello', 'callback' => 'fppTestsApiClashHello'));
}
function fppTestsApiClashHello() { return 'fpp-tests clashing plugin'; }
function GetTime() { return json(array('time' => 'fpp-tests hijacked')); }
`);
    goodPlugin();
    await fppApiAnswers(request);
    expect((await (await request.get('/api/time')).json()).time).not.toContain('hijacked');
    await goodPluginAnswers(request);
    const own = await request.get(`/api/plugin/${CLASH}/hello`);
    expect(await own.text(), 'the clashing plugin was loaded anyway').not.toContain('fpp-tests clashing plugin');
  } finally {
    removePlugins(CLASH, GOOD);
  }
});

test("a plugin's api.php that does not parse is skipped, and the API keeps working", async ({ request }) => {
  // Regression: afc777b8c.  The ParseError from require_once'ing a plugin's
  // api.php with a syntax error went uncaught, and every route in the API
  // answered 500.  Now the plugin is skipped and the error logged.
  const BROKEN = 'fpp-tests-api-broken';
  try {
    plugin(BROKEN, `<?php
function getEndpointsfpptestsapibroken() {
    return array(array('method' => 'GET', 'endpoint' => 'hello', 'callback' => 'fppTestsApiBrokenHello'
}
`);
    goodPlugin();
    await fppApiAnswers(request);
    await goodPluginAnswers(request);
  } finally {
    removePlugins(BROKEN, GOOD);
  }
});

test("the API docs list a plugin's PHP endpoint at the path it is served from", async ({ request }) => {
  // Regression: 37b274c3a.  /api/openapi.json listed a plugin's api.php
  // endpoints as /plugin/<name>/<endpoint>; every other path in the spec, and
  // its servers.url of "/", make that the URL a client calls, which 404s.  Now
  // they are listed at /api/plugin/<name>/<endpoint>.
  try {
    goodPlugin();
    const r = await request.get('/api/openapi.json');
    expect(r.status()).toBe(200);
    const spec = await r.json();
    const paths = Object.keys(spec.paths);
    const listed = paths.filter((p) => p.includes(GOOD));
    expect(listed, 'where the spec lists the plugin endpoint').toEqual([`/api/plugin/${GOOD}/hello`]);
    expect(spec.paths[listed[0]].get, 'the endpoint is a GET').toBeTruthy();
    // The control: the listed path, resolved against the spec's own server,
    // is the endpoint.
    const url = new URL(listed[0], new URL(spec.servers?.[0]?.url ?? '/', 'http://x')).pathname;
    await goodPluginAnswers(request);
    expect((await request.get(url)).status(), `GET ${url}`).toBe(200);
  } finally {
    removePlugins(GOOD);
  }
});
