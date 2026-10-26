import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile } from './settings-file';

// A text setting's input is printed with its saved value in value="...".
// The value was echoed unescaped: a quote ended the attribute, and markup
// after it became part of every page that showed the setting.
//
// emailfromtext is a plain text setting on the Email tab, printed by
// PrintSettingTextSaved() through PrintSetting().  The pages read the
// settings file dropping every double quote, except from a value shaped like
// JSON, so the stored value is a JSON array: it is saved and read back with
// its quotes, and is still just text to the input.

const SETTING = 'emailfromtext';
const VALUE = '["a\\"><u class=fpptestsinj>x</u><i x=\\""]';

test('a saved text setting holding a quote stays inside its input', async ({ page, request }) => {
  // Regression: edb6e6bf5.  PrintSettingText() and PrintSettingTextSaved()
  // echoed the value into the attribute as it was.
  test.skip(!container, 'needs the run-web.sh container');
  const before = settingInFile(SETTING) ?? '';
  expect((await request.put(`/api/settings/${SETTING}`, { data: VALUE })).ok()).toBe(true);
  try {
    // The control: the pages read the value back quotes and all.
    expect((await (await request.get(`/api/settings/${SETTING}`)).json()).value).toBe(VALUE);

    await page.goto('/settings.php?tab=Email');
    const input = page.locator(`input#${SETTING}`);
    await expect(input).toBeAttached({ timeout: 15_000 });
    await expect(page.locator('.fpptestsinj')).toHaveCount(0);
    await expect(input).toHaveValue(VALUE);

    // An edit saves the input's value: all of the stored value plus the
    // edit, not what was left of it before its first quote.
    await input.focus();
    await input.press('End');
    await input.pressSequentially('z');
    await input.press('Tab');
    await expect.poll(() => settingInFile(SETTING)).toBe(VALUE + 'z');
  } finally {
    await request.put(`/api/settings/${SETTING}`, { data: before });
  }
});
