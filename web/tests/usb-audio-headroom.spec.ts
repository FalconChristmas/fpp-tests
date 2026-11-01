import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { cleanupPipeWire } from './pw-helpers';
import { CARDS, callPhpWithEnv, cleanupAsound, fakeCards, standInAplay } from './fake-asound';
import { nullSink, startPipeWire, stopPipeWire } from './pw-live';

// The ALSA adapter the output groups conf (GeneratePipeWireGroupsConfig, run
// under PHP's CLI as in pw-calibration.spec.ts) creates for a card: its
// api.alsa.headroom depends on whether the card is USB (its own oscillator,
// which drifts against the graph's clock) and on whether it shares a group
// with another sink.  The sound cards are the fake /proc/asound of
// fake-asound.ts (card 0 the Pi's headphone jack, card 1 "S3", a USB card);
// the driver a card is bound to comes from fakereadlink.c, which stands in
// for /sys/class/sound.

test.skip(!container, 'stands in sound cards inside the run-web.sh container');

const SO = '/tmp/fpp-tests-fakereadlink.so';

test.beforeAll(() => {
  inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', SO, '/tests/web/tests/fakereadlink.c', '-ldl');
});
test.afterAll(() => inPlayer('rm', '-f', SO));
test.afterEach(() => {
  cleanupAsound();
  stopPipeWire();
  cleanupPipeWire();
});

const member = (cardId: string) => ({ cardId, cardName: cardId, channels: 2, sampleRate: 48000 });
const group = (id: number, ...cards: string[]) => ({ id, name: `G${id}`, enabled: true, channels: 2, members: cards.map(member) });

// The headroom of the adapter the generated conf has for `cardId`.
function headroom(groups: object[], cardId: string, usb = '1'): string | undefined {
  const sinks = [nullSink('fpp_alsa_s3', { 'api.alsa.path': 'hw:S3' }), nullSink('fpp_alsa_headphones', { 'api.alsa.path': 'hw:Headphones' })];
  fakeCards(CARDS);
  standInAplay();
  startPipeWire({ objects: sinks });
  const generated = callPhpWithEnv([`LD_PRELOAD=${SO}`, `FAKE_USB_CARDS=${usb}`], 'GeneratePipeWireGroupsConfig', groups);
  const conf: string = typeof generated === 'string' ? generated : generated.conf;
  const node = `fpp_alsa_${cardId.toLowerCase()}`;
  const at = conf.indexOf(`node.name = "${node}"`);
  expect(at, `no adapter ${node} in the generated conf:\n${conf}`).toBeGreaterThan(-1);
  return /api\.alsa\.headroom = (\d+)/.exec(conf.slice(at))?.[1];
}

test('a USB card sharing a group gets 4096 frames of headroom, alone in its group 1024, an onboard card 256', () => {
  // Regression: ba86d3216.  Every adapter had api.alsa.headroom = 256, too
  // little for a USB card whose clock drifts against the graph's: the
  // resampler resynced, heard as crackle.  (1ce4f6432 later charged the
  // full 4096 only to a card that shares a group.)
  expect(headroom([group(1, 'S3', 'Headphones')], 'S3')).toBe('4096');
  // The controls: the same card alone in its group, and an onboard card.
  expect(headroom([group(1, 'S3')], 'S3')).toBe('1024');
  expect(headroom([group(1, 'S3', 'Headphones')], 'Headphones')).toBe('256');
});
