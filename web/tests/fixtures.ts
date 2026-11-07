import { test as base } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
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

export const test = base.extend({
  context: async ({ context }, use) => {
    await coveringContext(context, use);
  },
  page: async ({ page, request }, use) => {
    await startCoverage(page);
    retryGotoOnNetworkChange(page);
    await request.put('/api/settings/themeOverride', { data: '' });
    await use(page);
    // A page that polls (status, warnings) can have a routed request in
    // flight when the test ends; its handler's route.fetch() then throws
    // "Target page, context or browser has been closed", which fails a test
    // that had passed. Drop the routes first, ignoring any still running.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
});

export { expect } from '@playwright/test';
