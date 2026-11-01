import { test, expect } from './fixtures';

// The Scheduler page's holiday list is the Locale's holiday table (plus the
// user's own), by display name.  USA and Canada list Boxing Day and
// New Year's Eve; the names are what a person picks from.
//
// Regression: 3cc470862.  The USA table had no Boxing Day, so the list
// lacked it.  Also e30e91bd6: New Year's Eve was spelled "New Years Eve" in
// both tables.

let locale = '';

test.beforeEach(async ({ request }) => {
  locale = String((await (await request.get('/api/settings/Locale')).json()).value ?? '');
});

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/Locale', { data: locale || 'Global' });
});

for (const [region, holidays] of [
  ['USA', { BoxingDay: 'Boxing Day', NewYearsEve: "New Year's Eve" }],
  ['Canada', { BoxingDay: 'Boxing Day', NewYearsEve: "New Year's Eve" }],
] as const) {
  test(`${region} locale lists Boxing Day and New Year's Eve by name`, async ({ page, request }) => {
    expect((await request.put('/api/settings/Locale', { data: region })).ok()).toBe(true);
    await page.goto('/scheduler.php');
    const options = await page.evaluate(() => {
      const holder = document.createElement('div');
      holder.innerHTML = (window as any).HolidaySelect('', '');
      return Array.from(holder.querySelectorAll('option')).map((o) => [o.value, o.textContent]);
    });
    const listed = Object.fromEntries(options as string[][]);
    for (const [short, name] of Object.entries(holidays)) {
      expect(listed[short], `${region} ${short}`).toBe(name);
    }
  });
}
