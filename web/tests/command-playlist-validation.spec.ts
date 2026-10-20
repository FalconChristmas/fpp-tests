import { test, expect } from './fixtures';

// What the Schedule, Command Presets, GPIO, Tasks and Playlists pages are told
// is wrong with a stored command or playlist entry before fppd ever runs it,
// and the playlist repeat route.

const PREFIX = 'fpp-tests-validate';

const playlist = (name: string, main: object[]) => ({
  name, desc: 'fpp-tests validation', repeat: 0, loopCount: 0,
  leadIn: [], mainPlaylist: main, leadOut: [],
});

test('stored commands are checked the way fppd will run them', async ({ request }) => {
  // Feature: cc2e5c6f1.  A command fppd no longer has (with its replacement
  // named), an argument naming a playlist that isn't there, a bad command
  // nested in an If, and nothing for a good command or for a multisync
  // command sent to named hosts, which runs there and not here.
  const commands = await (await request.get('/api/commands')).json();
  const ifDef = commands.find((c: { name: string }) => c.name === 'If');
  expect(ifDef, 'fppd lists the If command').toBeTruthy();
  const ifArgs = ifDef.args.map((a: { type: string }) =>
    a.type === 'commandlist'
      ? JSON.stringify([{ command: 'Start Playlist', args: [`${PREFIX}-nested-missing`, 'false', 'false'] }])
      : '');
  const r = await request.post('/api/validate/commands', {
    data: [
      { command: 'Remote Playlist Start', args: ['x'] },
      { command: 'Start Playlist', args: [`${PREFIX}-missing`, 'false', 'false'] },
      { command: 'If', args: ifArgs },
      { command: 'Stop Now', args: [] },
      { command: 'Start Playlist', args: [`${PREFIX}-missing`, 'false', 'false'],
        multisyncCommand: true, multisyncHosts: '192.0.2.10' },
    ],
  });
  expect(r.status(), await r.text()).toBe(200);
  const problems: string[][] = await r.json();
  expect(problems.length).toBe(5);
  expect(problems[0].join('|')).toContain("use 'Start Playlist'");
  expect(problems[1].join('|')).toContain(`'${PREFIX}-missing' not found`);
  expect(problems[2].join('|')).toContain(`${PREFIX}-nested-missing`);
  expect(problems[3]).toEqual([]);
  expect(problems[4]).toEqual([]);
});

test('playlist validation checks every entry type and says where', async ({ request }) => {
  // Feature: 6be16ed6a.  Before it only sequence and media files were
  // checked: a missing script, a sub-playlist that includes itself, a branch
  // to a playlist that isn't there and a removed command all passed as valid.
  const bad = `${PREFIX}-bad`;
  const good = `${PREFIX}-good`;
  try {
    for (const [name, main] of [
      [bad, [
        { type: 'script', enabled: 1, playOnce: 0, scriptName: `${PREFIX}-missing.sh`, blocking: 0 },
        { type: 'playlist', enabled: 1, playOnce: 0, name: bad },
        { type: 'branch', enabled: 1, playOnce: 0, branchTest: 'Time', startTime: '00:00:00',
          endTime: '01:00:00', trueNextBranchType: 'Playlist', trueBranchPlaylist: `${PREFIX}-missing`,
          falseNextBranchType: 'None' },
        { type: 'command', enabled: 1, playOnce: 0, command: 'Remote Run Script', args: ['x'] },
      ]],
      [good, [{ type: 'pause', enabled: 1, playOnce: 0, duration: 1 }]],
    ] as [string, object[]][]) {
      const saved = await request.post(`/api/playlist/${name}`, { data: playlist(name, main) });
      expect(saved.ok(), `saving ${name}: ${saved.status()}`).toBe(true);
    }
    const all = await (await request.get('/api/playlists/validate')).json();
    const b = all.find((p: { name: string }) => p.name === bad);
    const g = all.find((p: { name: string }) => p.name === good);
    expect(g?.valid, JSON.stringify(g)).toBe(true);
    expect(b?.valid, JSON.stringify(b)).toBe(false);
    const at = (i: number) => b.issues.filter((x: { section: string; index: number }) =>
      x.section === 'mainPlaylist' && x.index === i).map((x: { message: string }) => x.message).join('|');
    expect(at(0)).toContain(`${PREFIX}-missing.sh`);
    expect(at(1)).toContain('loop');
    expect(at(2)).toContain(`${PREFIX}-missing`);
    expect(at(3)).toContain('Remote Run Script');
  } finally {
    await request.delete(`/api/playlist/${bad}`);
    await request.delete(`/api/playlist/${good}`);
  }
});

test('the playlist repeat route sets repeat on the running playlist only', async ({ request }) => {
  // Feature: 483874dd5.  Idle, it is an error and nothing changes; while a
  // playlist runs it turns repeat on and /api/fppd/status shows it at once.
  const name = `${PREFIX}-repeat`;
  const status = async () => (await request.get('/api/fppd/status')).json();
  try {
    await request.post('/api/playlists/stop');
    await expect.poll(async () => (await status()).status_name, { timeout: 15_000 }).toBe('idle');
    const idle = await (await request.post('/api/playlist/repeat/true')).json();
    expect(idle.Status, JSON.stringify(idle)).toBe('Error');
    expect(idle.Message).toContain('No playlist is running');

    const saved = await request.post(`/api/playlist/${name}`, {
      data: playlist(name, [{ type: 'pause', enabled: 1, playOnce: 0, duration: 60 }]),
    });
    expect(saved.ok()).toBe(true);
    await request.post(`/api/playlist/${name}/start`);
    await expect.poll(async () => (await status()).status_name, { timeout: 15_000 }).toBe('playing');
    expect(String((await status()).repeat_mode)).toBe('0');
    const on = await (await request.post('/api/playlist/repeat/true')).json();
    expect(on.Status, JSON.stringify(on)).toBe('OK');
    expect(String((await status()).repeat_mode)).toBe('1');
    const bogus = await (await request.post('/api/playlist/repeat/maybe')).json();
    expect(bogus.Status).toBe('Error');
  } finally {
    await request.post('/api/playlists/stop');
    await request.delete(`/api/playlist/${name}`);
  }
});
