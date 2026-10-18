import { test as base } from '@playwright/test';

export const test = base.extend({
  page: async ({ page, request }, use) => {
    await request.put('/api/settings/themeOverride', { data: '' });
    await use(page);
  },
});

export { expect } from '@playwright/test';
