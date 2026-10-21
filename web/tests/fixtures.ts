import { test as base } from '@playwright/test';

export const test = base.extend({
  page: async ({ page, request }, use) => {
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
