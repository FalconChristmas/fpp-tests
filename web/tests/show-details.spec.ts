import { test, expect } from './fixtures';

// show_details() (fpp.js) builds the detail text of an error dialog from the
// arguments of a failed jQuery call.

test('an error dialog\'s details are built for arguments that carry no responseText', async ({ page }) => {
  // Regression: a stray console.log(arg) after the forEach, where arg is out of
  // scope, threw a ReferenceError for any failure whose first argument has no
  // responseText (a network abort, a bare string), so the dialog lost its
  // details.
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).show_details === 'function');
  const out = await page.evaluate(() => {
    try {
      return { ok: true, text: (window as any).show_details(['abort', 0]) as string };
    } catch (e) {
      return { ok: false, text: String(e) };
    }
  });
  expect(out.ok, out.text).toBe(true);
  expect(out.text).toContain('string: "abort"');
  expect(out.text).toContain('number: 0');
});

test('an error dialog\'s details are the response text when there is one', async ({ page }) => {
  // The other branch, as the control: the response text is shown as it is.
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).show_details === 'function');
  const text = await page.evaluate(() => (window as any).show_details([{ responseText: 'No such thing.' }]));
  expect(text).toBe('No such thing.');
});
