import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CARDS, Card, callApi, cleanupAsound, fakeCards } from './fake-asound';
import { cleanupPipeWire, commandLog, standInCommand, standInPwDump, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// /api/options/<name>: the choices a setting's select is filled from
// (options.php).  The GPIO lists come from fppd's pins (the container's are
// TF-1..TF-20) through a cape's show/hide rules; the audio input and mixer
// lists from the sound cards, here the ones fake-asound.ts stands in, run
// through PHP's CLI, and in PipeWire mode from pw-dump, also a stand-in.

test.skip(!container, 'stands in cape rules, sound cards and audio tools inside the run-web.sh container');

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';
const ALIASES = '/home/fpp/media/config/audio-card-aliases.json';

// A second Sound Blaster, the same model as card 1: ALSA gives it the id
// S3_1, and the same name.
const TWIN: Card = { num: 3, id: 'S3_1', driver: 'USB-Audio', name: 'Sound Blaster Play! 3',
  longName: 'Creative Technology Ltd Sound Blaster Play! 3 at usb-xhci-hcd.0-1.4, full speed',
  pcm: 'USB Audio : USB Audio : playback 1 : capture 1' };

let restoreSettings: () => void = () => {};
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
});
test.afterEach(() => {
  restoreSettings();
  cleanupAsound();
  cleanupPipeWire();
  inPlayer('rm', '-f', CAPE_INFO, ALIASES, '/usr/local/bin/amixer', '/tmp/fpp-tests-amixer.log');
});

const pins = (list: any[]) => list.map((g) => g.pin);

test("the GPIO lists offer fppd's pins, narrowed by the cape's show and hide rules", async ({ request }) => {
  const all = await (await request.get('/api/options/GPIOS')).json();
  expect(all.length).toBeGreaterThan(10);
  expect(all[0]).toMatchObject({ pin: 'TF-1', gpioChip: 0, gpioLine: 1 });
  // GPIOLIST is the same pins as a pin => label map.
  const list = await (await request.get('/api/options/GPIOLIST')).json();
  expect(Object.keys(list)).toEqual(pins(all));
  expect(list['TF-1']).toBe('TF-1');

  // A cape shows only the pins its rules match (as regexes), and of those
  // hides the ones its hide rules match.
  writeFile(CAPE_INFO, { id: 'fpp-tests', name: 'fpp-tests cape',
    show: { gpio: ['^TF-1\\d?$'] }, hide: { gpio: ['^TF-1[2-9]$'] } });
  const shown = ['TF-1', 'TF-10', 'TF-11'];
  expect(pins(await (await request.get('/api/options/GPIOS')).json())).toEqual(shown);
  expect(Object.keys(await (await request.get('/api/options/GPIOLIST')).json())).toEqual(shown);

  // Hide rules alone take pins out of the full list.
  writeFile(CAPE_INFO, { id: 'fpp-tests', name: 'fpp-tests cape', hide: { gpio: ['^TF-[2-9]$', '^TF-1\\d$'] } });
  expect(pins(await (await request.get('/api/options/GPIOS')).json())).toEqual(['TF-1', 'TF-20']);

  // Show All Options sets the cape's rules aside.
  setSettingInFile('showAllOptions', '1');
  expect(pins(await (await request.get('/api/options/GPIOS')).json())).toEqual(pins(all));
});

test('with ALSA, the audio input choices are the cards that can capture, one per card, with their aliases', () => {
  // PipeWire is the default backend; the full lists below are ALSA's.
  setSettingInFile('MediaBackend', 'alsa');
  fakeCards([...CARDS, TWIN]);
  // Only the two Sound Blasters capture: not the headphone jack, not the MIDI
  // keyboard.  Two cards of one name are told apart by their card numbers.
  expect(callApi('GetOptions_AudioInputDevice', false)).toEqual({
    'Sound Blaster Play! 3 (Card 1)': '1', 'Sound Blaster Play! 3 (Card 3)': '3' });
  // The full list names each capture device by card id and device name.
  expect(callApi('GetOptions_AudioInputDevice', true)).toEqual(['S3, USB Audio', 'S3_1, USB Audio']);
  // With media allowed, "Playing Media" comes first.
  expect(callApi('GetOptions_AudioInputDevice', true, true)).toEqual(['-- Playing Media --', 'S3, USB Audio', 'S3_1, USB Audio']);

  // A user's name for a card is shown with the card's own.
  writeFile(ALIASES, { aliases: { S3_1: 'Stage Mic' } });
  expect(callApi('GetOptions_AudioInputDevice', false)).toEqual({
    'Sound Blaster Play! 3': '1', 'Stage Mic (Sound Blaster Play! 3)': '3' });

  // The short list is the same with PipeWire: it names cards, not nodes.
  setSettingInFile('MediaBackend', 'pipewire');
  expect(Object.values(callApi('GetOptions_AudioInputDevice', false))).toEqual(['1', '3']);
});

test('in PipeWire mode the audio input choices are its sources, stored by name or by description', async ({ request }) => {
  setSettingInFile('MediaBackend', 'pipewire-simple');
  const source = (id: number, props: Record<string, string>) =>
    ({ id, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Source', ...props } } });
  standInPwDump([
    source(40, { 'node.name': 'alsa_input.usb-S3', 'node.description': 'Sound Blaster Play! 3', 'node.nick': 'S3' }),
    // The nick is not repeated when the description already has it.
    source(41, { 'node.name': 'alsa_input.mic', 'node.description': 'USB Mic (Mic2)', 'node.nick': 'Mic2' }),
    // FPP's own plumbing is never offered, nor anything that is not a source.
    source(42, { 'node.name': 'fpp_tee_group1', 'node.description': 'FPP tee' }),
    { id: 43, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'alsa_output.hdmi' } } },
    { id: 45, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'fpp_fx_out1', 'node.description': 'FPP EQ' } } },
    { id: 44, type: 'PipeWire:Interface:Port', info: { props: { 'media.class': 'Audio/Source', 'node.name': 'port' } } },
  ]);
  writeFile(ALIASES, { aliases: { Mic2: 'Podium' } });

  // AudioInputList is for SDL (the SMPTE plugin), which knows nodes only by
  // their description.
  expect(await (await request.get('/api/options/AudioInputList')).json()).toEqual({
    'Sound Blaster Play! 3 (S3)': 'Sound Blaster Play! 3', 'Podium (USB Mic (Mic2))': 'USB Mic (Mic2)' });
  // AudioInputListAllowMedia is for GStreamer, which wants node.name, and
  // offers the playing media first.
  expect(await (await request.get('/api/options/AudioInputListAllowMedia')).json()).toEqual({
    '-- Playing Media --': '-- Playing Media --',
    'Sound Blaster Play! 3 (S3)': 'alsa_input.usb-S3', 'Podium (USB Mic (Mic2))': 'alsa_input.mic' });

  // The output list is the sinks, by description (also for SDL): one with
  // no description goes by its name, and FPP's filter chains are left out.
  expect(await (await request.get('/api/options/AudioOutputList')).json()).toEqual({ 'alsa_output.hdmi': 'alsa_output.hdmi' });

  // Nothing from pw-dump, nothing offered.
  standInPwDump([]);
  inPlayer('sh', '-c', 'printf "#!/bin/sh\\nexit 1\\n" > /usr/local/bin/pw-dump');
  expect(await (await request.get('/api/options/AudioInputList')).json()).toEqual([]);
});

test("the mixer choices are the selected card's controls, asked of amixer by card number", () => {
  fakeCards();
  standInCommand('amixer', `[ "$1 $3" = "-c scontrols" ] || exit 1
printf "Simple mixer control 'PCM',0\\nSimple mixer control 'Mic',0\\n"`);
  // The card is saved by its ALSA id; amixer wants its number.
  setSettingInFile('AudioOutput', 'S3');
  expect(callApi('GetOptions_AudioMixerDevice')).toEqual({ PCM: 'PCM', Mic: 'Mic' });
  // A card saved by number by an older FPP, and no card saved at all (the
  // first card).
  setSettingInFile('AudioOutput', '1');
  callApi('GetOptions_AudioMixerDevice');
  setSettingInFile('AudioOutput', undefined);
  callApi('GetOptions_AudioMixerDevice');
  expect(commandLog('amixer')).toEqual(['-c 1 scontrols', '-c 1 scontrols', '-c 0 scontrols']);

  // A card amixer can't open offers no controls.
  standInCommand('amixer', 'echo "amixer: Invalid card number." >&2; exit 1');
  expect(callApi('GetOptions_AudioMixerDevice')).toEqual([]);
});

test('an option list that does not exist answers "{}", a string rather than an empty object', async ({ request }) => {
  const r = await request.get('/api/options/NoSuchSetting');
  expect(r.ok()).toBe(true);
  expect(await r.json()).toEqual('{}');
});
