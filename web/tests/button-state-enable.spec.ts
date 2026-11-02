import { test, expect } from './fixtures';

// SetButtonState() (fpp.js) enables and disables the buttons the pages
// drive from script (Save, Restart, the playlist controls).

test('enabling a button clears the disabled class Bootstrap styles it by, as well as the attribute', async ({ page }) => {
  // Regression: 47420b900 (#1522).  After the Bootstrap upgrade a button
  // that was marked disabled (class and attribute) came back clickable but
  // still drawn as disabled, because only the attribute was removed.
  // Also 4ff6e7ca9: removeAttr("disabled") became prop('disabled', false),
  // which this check passes either way.
  await page.goto('/about.php');
  await page.waitForFunction(() => typeof (window as any).SetButtonState === 'function');
  const state = await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'fppTestsButton';
    b.className = 'btn btn-success';
    b.setAttribute('data-btn-enabled-class', 'btn-success');
    document.body.appendChild(b);
    const w = window as any;
    const read = () => ({ disabled: b.disabled, attr: b.hasAttribute('disabled'), classes: b.className.split(/\s+/).sort() });
    w.SetButtonState('#fppTestsButton', 'disable');
    b.classList.add('disabled'); // as Bootstrap's own markup carries it
    const off = read();
    w.SetButtonState('#fppTestsButton', 'enable');
    return { off, on: read() };
  });
  expect(state.off).toMatchObject({ disabled: true, attr: true });
  expect(state.off.classes).toEqual(expect.arrayContaining(['disableButtons', 'disabled']));
  expect(state.on.disabled).toBe(false);
  expect(state.on.attr).toBe(false);
  expect(state.on.classes).not.toContain('disabled');
  expect(state.on.classes).not.toContain('disableButtons');
  expect(state.on.classes).toEqual(expect.arrayContaining(['buttons', 'btn-success']));
});
