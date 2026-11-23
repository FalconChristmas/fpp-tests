import { test as base } from '@playwright/test';
import type { BrowserContext, Page, Request, Response, Route } from '@playwright/test';
import { coveringContext, startCoverage } from './www-coverage';

// Chrome here runs on the host, beside the containers. A container or Docker
// network coming or going can make it drop requests in flight, and the page
// then "loads" without fpp.js or bootstrap, so the test times out on something
// unrelated. Only this error is retried: a page whose script is really missing
// still fails.
export const NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED';
const GOTO_ATTEMPTS = 4;

export function retryGotoOnNetworkChange(page: Page, errorText = NETWORK_CHANGED) {
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    for (let attempt = 1; ; attempt++) {
      let dropped = false;
      const onFailed = (r: Request) => {
        if (r.failure()?.errorText === errorText && ['document', 'script', 'stylesheet'].includes(r.resourceType())) dropped = true;
      };
      page.on('requestfailed', onFailed);
      try {
        const response = await goto(url, options);
        if (!dropped || attempt >= GOTO_ATTEMPTS) return response;
      } catch (e) {
        if (!String(e).includes(errorText) || attempt >= GOTO_ATTEMPTS) throw e;
      } finally {
        page.off('requestfailed', onFailed);
      }
    }
  };
}

// Requests a test's own route.fulfill() answered with an error status: the
// test asked for that failure, so it is not one of the player's.  A fulfill
// that passes the player's response on ({ response }, no status of its own)
// keeps the player's status, and counts.
const stubbedFailures = new WeakSet<Request>();
type RouteHandler = (route: Route, request: Request) => unknown;
function markStubbedFailures(target: Page | BrowserContext) {
  const route = target.route.bind(target) as (url: any, handler: RouteHandler, options?: any) => Promise<void>;
  (target as any).route = (url: any, handler: RouteHandler, options?: any) => route(url, (r: Route, req: Request) => {
    const fulfill = r.fulfill.bind(r);
    r.fulfill = (o?: Parameters<Route['fulfill']>[0]) => {
      if (o?.status !== undefined && o.status >= 400) stubbedFailures.add(req);
      return fulfill(o);
    };
    return handler(r, req);
  }, options);
}

// Every test fails if the page threw an uncaught exception (`pageerror`), e.g. a
// ReferenceError in a click handler (fpp #3209), whether or not the test looked
// for it. A test that expects one opts out with test.use({ allowPageErrors: true })
// (a file, or a describe block), saying why. A page that lost a script (no
// response, e.g. a dropped connection under load) throws for want of it, not
// for a fault in FPP, so then the errors are noted on the test, not thrown.
//
// Every test also fails if one of the player's own responses to the page was
// an error (4xx/5xx) that the test did not ask for with a route of its own: a
// save the page reports as done while its request failed, a missing script or
// image, a PHP fatal behind an XHR.  A test that expects one opts out with
// test.use({ allowFailedRequests: [/\/api\/thing/] }) (patterns matched against
// "METHOD /path?query 500"), or true for all, saying why.
// Reads a page makes on purpose for a config that may not have been saved,
// and handles a 404 as "nothing saved yet" (e.g. co-other.php GetChannelOutputs,
// channelinputs.php, outputs.js getUniverses, scheduler.php LoadUserHolidays,
// gpio.php loadGPIOConfig, recurringtasks.php LoadTasks, RunCommandDialog in
// fpp.js, the Virtual Display's background), and plugins.php's icons for listed plugins, which the player
// fetches from the plugin's own site and the test container cannot reach.
// None is a fault on a fresh player, so no test has to opt out of them.
const BY_DESIGN = [
  /^GET \/api\/channel\/output\/(co-[\w-]+|universeOutputs|universeInputs|dmxInputs)(\?\S*)? 404$/,
  /^GET \/api\/configfile\/(user-holidays|gpio|recurringtasks|instantCommand)\.json(\?\S*)? 404$/,
  /^GET \/api\/plugin\/[^/]+\/icon(\?\S*)? 404$/,
  // virtualdisplaybody.php tries the background a user may have uploaded.
  /^GET \/api\/file\/Images\/virtualdisplaybackground\.jpg 404$/,
];

export const test = base.extend<{ allowPageErrors: boolean; allowFailedRequests: boolean | RegExp[] }>({
  allowPageErrors: [false, { option: true }],
  allowFailedRequests: [false, { option: true }],
  context: async ({ context }, use) => {
    markStubbedFailures(context);
    await coveringContext(context, use);
  },
  page: async ({ page, request, allowPageErrors, allowFailedRequests, baseURL }, use, testInfo) => {
    markStubbedFailures(page);
    const origin = new URL(baseURL ?? 'http://127.0.0.1').origin;
    const failedRequests: Promise<string>[] = [];
    page.on('response', (r: Response) => {
      const req = r.request();
      if (r.status() < 400 || stubbedFailures.has(req)) return;
      const url = new URL(r.url());
      if (url.origin !== origin) return;
      const line = `${req.method()} ${url.pathname}${url.search} ${r.status()}`;
      if (BY_DESIGN.some((p) => p.test(line))) return;
      if (Array.isArray(allowFailedRequests) && allowFailedRequests.some((p) => p.test(line))) return;
      failedRequests.push(r.text().then((t) => `${line}: ${t.replace(/\s+/g, ' ').slice(0, 200)}`, () => line));
    });
    await startCoverage(page);
    retryGotoOnNetworkChange(page);
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.stack || String(e)));
    const lostScripts: string[] = [];
    page.on('requestfailed', (r) => { if (r.resourceType() === 'script') lostScripts.push(r.url()); });
    await request.put('/api/settings/themeOverride', { data: '' });
    await use(page);
    // A page that polls (status, warnings) can have a routed request in
    // flight when the test ends; its handler's route.fetch() then throws
    // "Target page, context or browser has been closed", which fails a test
    // that had passed. Drop the routes first, ignoring any still running.
    // Turning interception off while a request is being intercepted can
    // hang for good (about 1 run in 400 of overlay-models-page-save, whose
    // tests end on a save with the restart-flag PUT just going out), so it
    // gets 5 s; the page closes with its context all the same.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); }),
    ]);
    clearTimeout(timer);
    if (pageErrors.length && !allowPageErrors) {
      const report = `${pageErrors.length} uncaught page error(s):\n${pageErrors.join('\n---\n')}`;
      if (!lostScripts.length) throw new Error(report);
      testInfo.annotations.push({ type: 'page errors after lost scripts',
        description: `${report}\nscripts with no response:\n${lostScripts.join('\n')}` });
    }
    if (failedRequests.length && allowFailedRequests !== true) {
      const lines = await Promise.all(failedRequests);
      throw new Error(`${lines.length} failed request(s) to the player that the test did not ask for:\n${lines.join('\n')}`);
    }
  },
});

export { expect } from '@playwright/test';
