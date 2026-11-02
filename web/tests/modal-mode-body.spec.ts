import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile, setSettingInFile } from './settings-file';

// The standalone PipeWire/audio pages, loaded the way the settings dialogs
// load them (?modal=1).

test.skip(!container, 'sets the media backend in the settings file inside the run-web.sh container');

const KEYS = ['MediaBackend', 'AudioBackend'];
let saved: (string | undefined)[] = [];
test.beforeEach(() => {
  saved = KEYS.map(settingInFile);
  for (const k of KEYS) setSettingInFile(k, 'pipewire');
});
test.afterEach(() => KEYS.forEach((k, i) => setSettingInFile(k, saved[i])));

const PAGES = [
  'aes67-config.php', 'audio-card-aliases.php', 'opus-rtp-config.php',
  'pipewire-audio.php', 'pipewire-input-mixing.php', 'pipewire-video.php', 'vban-config.php',
];

for (const name of PAGES) {
  test(`${name} marks its body as modal-mode and takes the theme surface colour`, async ({ page }) => {
    // Regression: a535e905c.  A page in a settings dialog has no .pageContent
    // card, so the dark page background from fpp.css sat behind light-theme
    // text and buttons.  The fix puts class "modal-mode" on <body> when
    // ?modal=1, and body.modal-mode takes var(--bs-body-bg).
    await page.addInitScript(() => { try { localStorage.setItem('theme', 'light'); } catch {} });
    await page.goto(`/${name}?modal=1&t=${Date.now()}`);
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'light'));
    await expect(page.locator('body')).toHaveClass(/modal-mode/);
    const { bg, surface } = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--bs-body-bg)';
      document.body.appendChild(probe);
      const surface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { bg: getComputedStyle(document.body).backgroundColor, surface };
    });
    expect(bg, 'body background in a dialog').toBe(surface);
    expect(bg, 'not the dark page background').not.toBe('rgb(32, 34, 46)');

    // Opened as a normal page it stays unmarked.
    await page.goto(`/${name}?t=${Date.now()}`);
    await expect(page.locator('body')).not.toHaveClass(/modal-mode/);
  });
}
