import { test, expect } from './fixtures';
import { container } from './container';
import { sh } from './plugin-repo';
import { CommandSocketSpy } from './command-socket-spy';

// The commands the PHP sends fppd over its local command socket are ones the
// socket has: a spy relays them to fppd and records its replies.

test.skip(!container, 'relays fppd\'s command socket inside the run-web.sh container');

const CONFIG = '/home/fpp/media/config';

test('saving the holidays and clearing the video groups send fppd only commands it knows', async ({ request }) => {
  // Regression: d668b5d31.  Saving user-holidays.json sent "Clear Locale
  // Cache,true" over the command socket, which has no such command (it is an
  // FPP Command), and the PipeWire endpoints sent "setSetting", where the
  // socket's commands are case-sensitive ("SetSetting"); fppd answered every
  // one "Invalid command".  Now the holidays save sends nothing (fppd notices
  // the file change itself) and the settings go as SetSetting.
  const spy = new CommandSocketSpy();
  const saved = ['user-holidays.json', 'pipewire-video-groups.json'];
  sh(saved.map((f) => `if [ -e ${CONFIG}/${f} ]; then mv ${CONFIG}/${f} ${CONFIG}/${f}.fpp-tests; fi`).join('\n'));
  spy.start();
  try {
    const holidays = [{ name: 'fpp-tests day', shortName: 'FppTestsDay', month: 3, day: 14 }];
    const save = await request.post('/api/configfile/user-holidays.json', { data: JSON.stringify(holidays) });
    expect(save.ok(), await save.text()).toBe(true);

    // No video output groups: the apply clears fppd's five video sink settings.
    const apply = await request.post('/api/pipewire/video/groups/apply', { timeout: 60_000 });
    expect(apply.ok(), await apply.text()).toBe(true);

    const seen = spy.exchanges();
    const shown = seen.map((e) => `${e.command} -> ${JSON.stringify(e.reply)}`).join('\n');
    // The control: the clears reached fppd through the spy.
    expect(seen.filter((e) => /^SetSetting,PipeWireVideoSinkName/i.test(e.command)).length, shown).toBe(5);
    expect(seen.filter((e) => (e.reply ?? '').startsWith('Invalid command')), shown).toEqual([]);
  } finally {
    spy.stop();
    sh([`rm -f ${CONFIG}/user-holidays.json`,
      ...saved.map((f) => `if [ -e ${CONFIG}/${f}.fpp-tests ]; then mv ${CONFIG}/${f}.fpp-tests ${CONFIG}/${f}; fi`)].join('\n'));
  }
  // fppd answers on its socket again.
  const r = await request.get('/api/fppd/status');
  expect(r.ok()).toBe(true);
});
