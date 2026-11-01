import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// A song whose name holds a quote and a dollar sign is probed under that
// exact name.  Regression: 024fae795.  api/media/<name>/meta built its
// ffprobe command with the file path inside double quotes, so the shell
// ended the argument at the name's own quote and expanded its $variable:
// ffprobe was asked about some other path and the song had no metadata.
// The path now goes through escapeshellarg.
//
// The container has no ffprobe; a stand-in on /usr/bin records the argument
// it was given (the receiving end) and answers with a duration.

test.skip(!container, 'seeds a song and an ffprobe stand-in inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const SONG = `it's "a" $HOME \`id\`.wav`;
const FFPROBE = '/usr/bin/ffprobe';
const SEEN = '/tmp/fpp-tests-ffprobe-argv';

test('a song named with a quote and a dollar sign is handed to ffprobe whole', async ({ request }) => {
  const had = inPlayer('sh', '-c', `test -e ${FFPROBE} && echo y || echo n`).trim() === 'y';
  test.skip(had, 'the player has a real ffprobe, which would not record its argument');
  putFile(FFPROBE, [
    '#!/usr/bin/python3 -I',
    'import json, sys',
    `open("${SEEN}", "w").write(chr(10).join(sys.argv[1:]))`,
    'print(json.dumps({"streams": [], "format": {"format_name": "wav", "duration": "3.5"}}))',
    '',
  ].join('\n'));
  inPlayer('chmod', '755', FFPROBE);
  inPlayer('rm', '-f', SEEN, `${MEDIA}/config/media_durations.cache`);
  // Piped in: docker cp doesn't follow the media directory's symlink.
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'cat > "$1"', 'sh', `${MEDIA}/music/${SONG}`],
    { input: Buffer.from('RIFF'), stdio: ['pipe', 'ignore', 'pipe'] });
  try {
    const res = await request.get(`/api/media/${encodeURIComponent(SONG)}/meta`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Number(body?.format?.duration), JSON.stringify(body)).toBeCloseTo(3.5, 1);
    const argv = inPlayer('cat', SEEN).split('\n');
    // The media directory is a symlink, so the front of the path varies.
    expect(argv[argv.length - 1].endsWith(`/music/${SONG}`), argv.join('|')).toBe(true);
  } finally {
    execFileSync('docker', ['exec', container, 'sh', '-c', 'rm -f "$1"', 'sh', `${MEDIA}/music/${SONG}`]);
    inPlayer('rm', '-f', FFPROBE, SEEN, `${MEDIA}/config/media_durations.cache`);
  }
});
