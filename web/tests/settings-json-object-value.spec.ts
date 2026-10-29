import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, php, readSettingsFile } from './privacy-helpers';

// How WriteSettingToFile() (www/common.php) stores a setting whose value is a
// JSON object -- the LED panel matrices are kept so -- and a plain value that
// only happens to parse as JSON.  The receiving end is config.php's reader,
// which every page and API call loads the settings through.

test.skip(!container, 'reads the settings file inside the run-web.sh container');

const NAME = 'fppTestsJsonObject';
const NUMBER = 'fppTestsJsonNumber';
const VALUE = '{"description": "two words", "panels": [{"row": 0, "col": 1}]}';

test('a JSON object setting keeps the spaces in its strings, and a number stays a quoted string', async ({ request }) => {
  // Regression: d45cdbe6a ("another step further with panels").  Every
  // value json_validate() accepted -- a number as much as an object -- was
  // written unquoted with all its whitespace stripped, so a JSON setting's
  // "two words" came back "twowords" the next time any setting was saved.
  await keepingSettings(async () => {
    let r = await request.put(`/api/settings/${NAME}`, { data: VALUE, headers: { 'Content-Type': 'text/plain' } });
    expect(r.ok(), await r.text()).toBe(true);
    // A second write, of another setting, rewrites every line of the file.
    r = await request.put(`/api/settings/${NUMBER}`, { data: '42', headers: { 'Content-Type': 'text/plain' } });
    expect(r.ok(), await r.text()).toBe(true);
    const lines = readSettingsFile().split('\n');
    expect(lines).toContain(`${NAME} = ${VALUE}`);
    expect(lines).toContain(`${NUMBER} = "42"`);
    // Read back as the pages and the API see it.
    const back = JSON.parse(php(`echo json_encode([$settings['${NAME}'], $settings['${NUMBER}']]);`));
    expect(JSON.parse(back[0])).toEqual(JSON.parse(VALUE));
    expect(back[1]).toBe('42');
  });
});
