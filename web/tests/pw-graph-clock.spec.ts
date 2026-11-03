import { test, expect } from './fixtures';
import { container } from './container';
import { cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { callPhp } from './fake-asound';

// SyncBootGraphClock (run under PHP's CLI, as in usb-audio-headroom.spec.ts)
// keeps default.clock.rate in the boot-time 95-fpp-alsa-sink.conf in step with
// where the audio goes.  fppinit pins it to the sound card's own clock, which
// on a fixed-clock cape (an AM62x PCM5102A) is 88200; with only AES67 senders
// in the output groups nothing is played to the card, and the graph should
// run at the 48 kHz the stream is on the wire.

test.skip(!container, 'edits the boot conf inside the run-web.sh container');

const CONF = '/etc/pipewire/pipewire.conf.d/95-fpp-alsa-sink.conf';

// What fppinit writes for such a cape.
const BOOT = `# FPP ALSA sink adapters (generation 8)
# configured rate: 48000
# period size: 1024
# cards: capeaudiopcm510
# usb shared-group cards:
context.properties = {
    default.clock.rate = 88200
}
context.objects = [
  { factory = adapter
    args = {
      factory.name = api.alsa.pcm.sink
      node.name = "fpp_alsa_capeaudiopcm510"
      api.alsa.path = "hw:CapeAudiopcm510"
      audio.rate = 48000
    }
  }
]
`;

test.beforeEach(() => writeFile(CONF, BOOT));
test.afterEach(() => cleanupPipeWire());

const member = (cardId: string) => ({ cardId, channels: 2, delayMs: 0 });
const group = (id: number, ...cards: string[]) => ({ id, name: `G${id}`, enabled: true, members: cards.map(member) });

const clock = () => /default\.clock\.rate = (\d+)/.exec(readFile(CONF))?.[1];
// SyncBootGraphClock($groups, $SUDO): the container's PHP runs as root.
const sync = (groups: object[], priority = false) => callPhp('SyncBootGraphClock', groups, '', priority) as boolean;

test('groups of only AES67 senders run the graph at 48 kHz, and a card rejoining puts its clock back', () => {
  // Regression: c497786e3.  The boot conf pinned the graph to the card's
  // 88200 whatever the groups held, so an AES67-only output was converted
  // down from 88.2 kHz by PipeWire for no listener.
  expect(sync([group(1, 'aes67_1')])).toBe(true);
  expect(clock()).toBe('48000');
  // Said once: applying the same groups again changes nothing, so it does
  // not ask for a PipeWire restart each time.
  expect(sync([group(1, 'aes67_1')])).toBe(false);
  expect(clock()).toBe('48000');

  // A card in a group with the sender: the card's own clock again, and the
  // file is byte for byte what fppinit wrote.
  expect(sync([group(1, 'aes67_1', 'CapeAudiopcm510')])).toBe(true);
  expect(clock()).toBe('88200');
  expect(readFile(CONF)).toBe(BOOT);
});

test('a card in any enabled group, or no AES67 sender at all, leaves the card clock alone', () => {
  // The controls: each of these must not touch the file.
  expect(sync([group(1, 'CapeAudiopcm510')])).toBe(false);
  expect(sync([group(1, 'aes67_1'), group(2, 'CapeAudiopcm510')])).toBe(false);
  expect(sync([])).toBe(false);
  expect(readFile(CONF)).toBe(BOOT);

  // A disabled group does not count: only the enabled AES67 one does.
  const off = { ...group(2, 'CapeAudiopcm510'), enabled: false };
  expect(sync([group(1, 'aes67_1'), off])).toBe(true);
  expect(clock()).toBe('48000');
});

test('with AES67 priority on, a card beside the sender no longer keeps its clock for the graph', () => {
  // AES67GraphClockPriority: the stream's 48 kHz wins over a card that shares
  // its group, and the card's adapter converts up to its own clock.
  const both = [group(1, 'aes67_1', 'CapeAudiopcm510')];
  // Off (the default): the card's clock, as before.
  expect(sync(both)).toBe(false);
  expect(clock()).toBe('88200');
  // On: 48 kHz, said once.
  expect(sync(both, true)).toBe(true);
  expect(clock()).toBe('48000');
  expect(sync(both, true)).toBe(false);
  // Turned off again and applied: the card's clock is put back exactly.
  expect(sync(both, false)).toBe(true);
  expect(readFile(CONF)).toBe(BOOT);
  // The control: priority does nothing for groups with no AES67 sender.
  expect(sync([group(1, 'CapeAudiopcm510')], true)).toBe(false);
  expect(readFile(CONF)).toBe(BOOT);
});
