import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingFile, writeFile, MEDIA } from './privacy-helpers';

// Two things about api/files that the File Manager and the support zip rely on.

test.skip(!container, 'seeds files in the run-web.sh container');

test('the config zip holds the command presets and the instant command', async ({ request }) => {
  // Regression: 9985e9668.  GET /api/files/zip/config (the config half of the
  // support zip) listed the output and schedule files by name but not
  // config/commandPresets.json or config/instantCommand.json, so a downloaded
  // backup lost the user's command presets.
  const presets = `${MEDIA}/config/commandPresets.json`;
  const instant = `${MEDIA}/config/instantCommand.json`;
  await keepingFile(presets, () => keepingFile(instant, async () => {
    writeFile(presets, '{"commands":[{"name":"fpp-tests-preset-marker","command":"Volume Set","args":["50"]}]}');
    writeFile(instant, '{"command":"fpp-tests-instant-marker","args":[]}');
    const r = await request.get('/api/files/zip/config');
    expect(r.status()).toBe(200);
    const body = await r.body();
    // The control: it is a zip, and holds files the list always had.
    expect(body.subarray(0, 2).toString()).toBe('PK');
    expect(body.includes(Buffer.from('settings')), 'the control: settings is in the zip').toBe(true);
    // The receiving end: both files are entries of the zip, with the content.
    expect(body.includes(Buffer.from('config/commandPresets.json')), 'commandPresets.json is not in the zip').toBe(true);
    expect(body.includes(Buffer.from('config/instantCommand.json')), 'instantCommand.json is not in the zip').toBe(true);
  }));
});

test('listing a folder in the File Manager does not go through sudo', async ({ request }) => {
  // Regression: ca1cd1166.  Every folder listing ran its find under sudo even
  // when the web server already was fpp or root, and each sudo wrote PAM
  // authentication lines to the log.  Skipped when the user is fpp or root.
  const STUB = '/usr/local/bin/sudo';
  const LOG = '/tmp/fpp-tests-files-sudo.log';
  const music = `${MEDIA}/music/fpp-tests-no-sudo.mp3`;
  try {
    writeFile(music, 'x');
    writeFile(STUB, `#!/bin/sh\necho "$*" >> ${LOG}\nexec "$@"\n`);
    inPlayer('sh', '-c', `chmod 755 ${STUB}; : > ${LOG}; chmod 666 ${LOG}`);
    const calls = () => inPlayer('sh', '-c', `cat ${LOG}`).split('\n').filter((l) => l.trim());
    // The control: the web server's shell commands do find the stand-in
    // (the support zip reads root's sound config under sudo).
    await request.get('/api/files/zip/config');
    expect(calls().join('\n'), 'the stand-in sudo is not the one the web server runs').toContain('cat /root/.asoundrc');

    inPlayer('sh', '-c', `: > ${LOG}`);
    const r = await request.get('/api/files/music');
    expect(r.ok()).toBe(true);
    expect(JSON.stringify(await r.json())).toContain('fpp-tests-no-sudo.mp3');
    const named = await request.get('/api/files/music?nameOnly=1');
    expect(JSON.stringify(await named.json())).toContain('fpp-tests-no-sudo.mp3');
    expect(calls().filter((c) => c.includes('find')), 'a listing ran find under sudo').toEqual([]);
  } finally {
    inPlayer('sh', '-c', `rm -f ${STUB} ${LOG} ${music}`);
  }
});
