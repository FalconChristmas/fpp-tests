import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile, setSettingInFile, snapshotSettings } from './settings-file';

// The "dtoverlay=gpio-fan" line FPP manages in the boot config.txt, from the
// GPIOFan setting. A cape that drives its own fan from its own overlay must
// not also get FPP's: two cooling devices and two trip points on one pin.
//
// The boot actions are run the way fppinit runs them after a restore or an
// upgrade, with BootActions=settings.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const CONFIG = '/boot/config.txt';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const FAN = 'dtoverlay=gpio-fan,gpiopin=14,temp=70000';
const INDENTED = '  dtoverlay=gpio-fan,gpiopin=4,temp=60000';

let restoreSettings: () => void;
let hadConfig: boolean;
let hadCapeInfo: boolean;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  hadConfig = exists(CONFIG);
  hadCapeInfo = exists(CAPE_INFO);
  test.skip(hadConfig || hadCapeInfo, 'the player already has a boot config.txt or a cape');
  putFile(CONFIG, `# fpp-tests\ndtparam=audio=on\n[all]\n${FAN}\n${INDENTED}\n`);
});
test.afterEach(() => {
  restoreSettings();
  if (!hadConfig) inPlayer('rm', '-f', CONFIG);
  if (!hadCapeInfo) inPlayer('rm', '-f', CAPE_INFO);
});

function runBootActions() {
  setSettingInFile('BootActions', 'settings');
  return inPlayer('/opt/fpp/scripts/handle_boot_actions');
}

const lines = () => readFile(CONFIG).split('\n');

// Regression: d7c527823 ("Remove the managed gpio-fan line when the GPIOFan
// setting goes away"). The boot actions applied GPIOFan only when the key was
// present, so once a cape's removeSettings took it away the line stayed in
// config.txt for good.
test('the fan line goes when GPIOFan is gone, and is commented out at "0"', async ({ request }) => {
  setSettingInFile('GPIOFan', undefined);
  const out = runBootActions();
  expect(out).toContain('Performing boot action: settings');
  expect(lines(), 'the managed fan line stayed with GPIOFan gone').not.toContain(FAN);
  // Only the lines FPP manages: an indented one is not one of them.
  expect(lines()).toContain(INDENTED);
  expect(lines()).toContain('dtparam=audio=on');

  // "0" is a fan fitted and switched off: the line is kept, commented out.
  // (Any other mention of the overlay, the indented line included, stops FPP
  // adding its own, so that goes first.)
  putFile(CONFIG, lines().filter((l) => l !== INDENTED).join('\n'));
  expect((await request.put('/api/settings/GPIOFan?skipBackup=1', { data: '0' })).ok()).toBe(true);
  expect(lines()).toContain(`#${FAN}`);
  expect(lines()).not.toContain(FAN);
});

// Regression: 63423598d ("Let a cape that hides GPIOFan own the fan
// outright"). A cape hides GPIOFan when its own overlay declares the fan, but
// a GPIOFan value written by an earlier eeprom's defaults was kept (its
// removeSettings refuses to overrule what looks like a user's choice), so FPP
// went on writing its line next to the cape's fan.
test('a cape that hides GPIOFan gets no fan line, whatever GPIOFan holds', async () => {
  putFile(CAPE_INFO, JSON.stringify({ id: 'fpp-tests', name: 'fpp-tests cape', hide: { settings: ['GPIOFan'] } }));
  setSettingInFile('GPIOFan', '1');
  runBootActions();
  expect(lines(), "FPP's fan line was written beside the cape's own").not.toContain(FAN);
  expect(lines().filter((l) => /^#?dtoverlay=gpio-fan/.test(l))).toEqual([]);
  expect(lines()).toContain(INDENTED);

  // The control: without the cape, the same setting writes the line.
  inPlayer('rm', '-f', CAPE_INFO);
  putFile(CONFIG, `# fpp-tests\n[all]\n${FAN}\n`);
  runBootActions();
  expect(lines()).toContain(FAN);
});

// Regression: b2185d34f ("write the GPIO fan line even when config.txt
// mentions the overlay elsewhere"). The line was added only when the text
// appeared nowhere in config.txt, but only line-anchored ones were rewritten:
// an indented copy or a comment naming the overlay left GPIOFan on with no line.
test('GPIOFan on writes its line beside other mentions of the overlay', async ({ request }) => {
  putFile(CONFIG, `# fpp-tests: see dtoverlay=gpio-fan in the overlay README\ndtparam=audio=on\n${INDENTED}\n`);
  setSettingInFile('GPIOFan', undefined);
  expect((await request.put('/api/settings/GPIOFan?skipBackup=1', { data: '1' })).ok()).toBe(true);
  expect(lines(), 'no fan line was written').toContain(FAN);
  expect(lines()).toContain(INDENTED);
});
