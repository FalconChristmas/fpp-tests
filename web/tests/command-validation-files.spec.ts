import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// POST /api/validate/commands is what puts the warning triangle on a stored
// command (a GPIO input, a schedule, a preset): each command comes back with
// the reasons fppd would fail to run it (www/api/controllers/validate.php
// validateFPPCommand; removed commands, playlists and nested commands are in
// command-playlist-validation.spec.ts).  Here the arguments that name a file:
// a sequence, an effect, a script, media.

test.skip(!container, 'seeds files inside the run-web.sh container');

const N = 'fpp-tests-cmdval';
const FILES = [
  `${MEDIA}/sequences/${N}.fseq`, `${MEDIA}/effects/${N}.eseq`, `${MEDIA}/scripts/${N}.sh`,
  `${MEDIA}/music/${N}.mp3`, `${MEDIA}/videos/${N}.mp4`, `${MEDIA}/playlists/${N}.json`,
];
const clean = () => inPlayer('sh', '-c', `rm -f ${FILES.map((f) => `'${f}'`).join(' ')}`);
test.beforeEach(() => { clean(); for (const f of FILES) putFile(f, f.endsWith('.json') ? '{"name":"x","mainPlaylist":[]}' : 'x'); });
test.afterEach(clean);

const check = async (request: any, cmds: unknown[]) => {
  const r = await request.post('/api/validate/commands', { data: cmds });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as string[][];
};

test('a file a command names is looked for where fppd looks, with and without its extension', async ({ request }) => {
  const good = [
    { command: 'FSEQ Effect Start', args: [N] },
    { command: 'FSEQ Effect Start', args: [`${N}.fseq`] },
    { command: 'Effect Start', args: [N] },
    { command: 'Effect Start', args: [`${N}.eseq`] },
    { command: 'Run Script', args: [`${N}.sh`] },
    { command: 'Play Media', args: [`${N}.mp3`] },
    { command: 'Play Media', args: [`${N}.mp4`] },
    { command: 'Play Media', args: [`${MEDIA}/music/${N}.mp3`] },   // a full path, as given
    { command: 'Start Playlist', args: [N] },
    { command: 'Start Playlist', args: [`${N}.fseq`] },              // a sequence is playable
    { command: 'Start Playlist At Item', args: [N, '1'] },
  ];
  expect(await check(request, good)).toEqual(good.map(() => []));
});

test('a file that is not there is named in the reason, by the argument it was given for', async ({ request }) => {
  expect(await check(request, [
    { command: 'FSEQ Effect Start', args: [`${N}-gone`] },
    { command: 'Effect Start', args: [`${N}-gone`] },
    { command: 'Run Script', args: [N] },                            // a script needs its whole name
    { command: 'Play Media', args: [`${N}.wav`] },
    { command: 'Play Media', args: [`/home/fpp/media/music/${N}-gone.mp3`] },
    { command: 'Start Playlist', args: [`${N}-gone.fseq`] },
    { command: 'Start Playlist At Item', args: [`${N}.fseq`, '1'] }, // this one takes playlists only
    { command: 'Effect Start', args: [`${N}.fseq`] },                // a sequence is not an effect
  ])).toEqual([
    [`Command 'FSEQ Effect Start': FSEQ Name '${N}-gone' not found`],
    [`Command 'Effect Start': Effect Name '${N}-gone' not found`],
    [`Command 'Run Script': Script Name '${N}' not found`],
    [`Command 'Play Media': Media '${N}.wav' not found`],
    [`Command 'Play Media': Media '/home/fpp/media/music/${N}-gone.mp3' not found`],
    [`Command 'Start Playlist': Playlist Name '${N}-gone.fseq' not found`],
    [`Command 'Start Playlist At Item': Playlist Name '${N}.fseq' not found`],
    [`Command 'Effect Start': Effect Name '${N}.fseq' not found`],
  ]);
});

test('an argument that is empty, a %variable% or not text is not looked for', async ({ request }) => {
  expect(await check(request, [
    { command: 'Run Script', args: [''] },
    { command: 'Run Script', args: ['%script%'] },
    { command: 'Play Media', args: [`%dir%/${N}-gone.mp3`] },
    { command: 'Run Script', args: [['a', 'b']] },
    { command: 'Run Script' },
    { command: 'Run Script', args: 'not a list' },
    // Named hosts run it, with their own files.
    { command: 'Run Script', args: [`${N}-gone.sh`], multisyncCommand: true, multisyncHosts: '192.0.2.10' },
  ])).toEqual([[], [], [], [], [], [], []]);
  // With no hosts it runs here too, so it is checked.
  expect(await check(request, [{ command: 'Run Script', args: [`${N}-gone.sh`], multisyncCommand: true, multisyncHosts: '' }]))
    .toEqual([[`Command 'Run Script': Script Name '${N}-gone.sh' not found`]]);
});

test('each entry gets its own answer, in order; what is not a command gets none; a body that is no list is refused', async ({ request }) => {
  expect(await check(request, [
    { command: '' }, 'text', 7, null, {},
    { command: `${N} no such command`, args: [] },
    { command: 'Stop Now' },
  ])).toEqual([[], [], [], [], [],
    [`Unknown command '${N} no such command' (it may come from a plugin that is not installed)`], []]);
  expect(await check(request, [])).toEqual([]);

  for (const body of ['"Stop Now"', '7', '{"command":', '']) {
    const r = await request.post('/api/validate/commands', { data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });
    expect(r.status(), body).toBe(400);
    expect(await r.text(), body).toContain('Expected a JSON array of commands');
  }
});

test('a file outside its folder is not taken for one in it', async ({ request }) => {
  test.fail(true, 'the name is joined to the folder as given: "../" and any absolute path count as found (FUTURE.md)');
  // fppd runs a script from the scripts folder only; the settings file is
  // there on every player, and is no script.
  expect(await check(request, [
    { command: 'Run Script', args: ['../settings'] },
    { command: 'Run Script', args: [`${MEDIA}/settings`] },
    { command: 'FSEQ Effect Start', args: [`../scripts/${N}.sh`] },
  ])).toEqual([
    [`Command 'Run Script': Script Name '../settings' not found`],
    [`Command 'Run Script': Script Name '${MEDIA}/settings' not found`],
    [`Command 'FSEQ Effect Start': FSEQ Name '../scripts/${N}.sh' not found`],
  ]);
});
