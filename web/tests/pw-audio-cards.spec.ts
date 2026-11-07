import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, exists, fakeSoundCards, sinkNode, standInCommand, standInPwDump, writeFile } from './pw-helpers';

// GET /api/pipewire/audio/cards: the sound cards an output group can use,
// each with the PipeWire sink that plays to it, and the AES67, Opus RTP and
// VBAN senders alongside them.  A card's sink is found, in order, from the
// alsa.card (or api.alsa.path) of a sink in pw-dump, then from its
// /dev/snd/by-id or by-path name among the sinks pactl lists, then from the
// output profiles pactl lists for its card.  The cards are fake /proc/asound
// entries, and pw-dump, pactl and amixer are stand-ins.

test.skip(!container, "writes the run-web.sh container's sound cards and Pipewire config");

const FAKE = '/tmp/fpp-tests-fakeasound';
let devSndBefore = true;

test.beforeEach(() => {
  devSndBefore = exists('/dev/snd');
});

test.afterEach(() => {
  cleanupPipeWire();
  inPlayer('sh', '-c', `rm -f ${CONFIG}/pipewire-aes67-instances.json ${CONFIG}/pipewire-opus-rtp-instances.json ` +
    `${CONFIG}/audio-card-aliases.json /tmp/fpp-tests-pactl-*.txt`);
  if (!devSndBefore) inPlayer('rm', '-rf', '/dev/snd');
});

// pactl: `list sinks short` and `list cards` print what is given.
function standInPactl(sinks: string[], cards = '') {
  writeFile('/tmp/fpp-tests-pactl-sinks.txt', sinks.map((s, i) => `${50 + i}\t${s}\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n`).join(''));
  writeFile('/tmp/fpp-tests-pactl-cards.txt', cards);
  standInCommand('pactl', [
    'case "$*" in',
    '  *"list sinks short"*) cat /tmp/fpp-tests-pactl-sinks.txt ;;',
    '  *"list cards"*) cat /tmp/fpp-tests-pactl-cards.txt ;;',
    'esac',
  ].join('\n') + '\n');
}

// /dev/snd/by-id or by-path links to a card's control device.
function devLinks(dir: 'by-id' | 'by-path', links: Record<string, number>) {
  inPlayer('mkdir', '-p', `/dev/snd/${dir}`);
  for (const [name, card] of Object.entries(links)) {
    inPlayer('ln', '-sfn', `../controlC${card}`, `/dev/snd/${dir}/${name}`);
  }
}

const pactlCard = (id: string, lines: string[]) =>
  `Card #${id.length}\n\tName: alsa_card.${id}\n\tDriver: alsa\n\tProperties:\n` +
  `\t\tdevice.bus_path = "${id}"\n\tProfiles:\n${lines.map((l) => `\t\t${l}\n`).join('')}`;

type Card = { cardNum: number; cardId: string; pwNodeName: string; channels: number; [k: string]: unknown };

test('each card is matched to the sink that plays to it, by the surest name it has', async ({ request }) => {
  const ids = ['Raw', 'Adapter', 'UsbById', 'PathBase', 'PathExact', 'Legacy', 'LegacyDump',
    'Profile', 'Hdmi', 'UsbGuess', 'Lost', 'Dac8x', 'MicOnly'];
  fakeSoundCards(ids.map((id) => ({ id, name: id === 'Dac8x' ? 'snd_rpi_hifiberry_dac8x' : `${id} Card` })));
  writeFile(`${FAKE}/pcm`, [
    '00-00: Raw PCM : Raw PCM : playback 1',
    '00-01: Raw Second : Raw Second : playback 1', // the same card again: listed once
    '01-00: Adapter PCM : Adapter PCM : playback 1',
    '02-00: USB Audio : USB Audio : playback 1 : capture 1',
    ...ids.slice(3, 12).map((_, i) => `${String(i + 3).padStart(2, '0')}-00: PCM : PCM : playback 1`),
    '12-00: Mic : Mic : capture 1', // nothing to play to
  ].join('\n') + '\n');
  // A USB card's playback altsets give its channels, not the capture ones.
  writeFile(`${FAKE}/card2/stream0`, 'USB Audio\n\nPlayback:\n  Altset 1\n  Channels: 4\n\nCapture:\n  Channels: 10\n');

  standInPwDump([
    sinkNode(1, 'alsa_output.platform-raw.analog-stereo', { 'alsa.card': 0, 'audio.channels': 6 }),
    // A filter-chain on the same card does not take its place.
    sinkNode(2, 'fpp_fx_g1_raw', { 'alsa.card': 0 }),
    sinkNode(3, 'fpp_alsa_adapter', { 'api.alsa.path': 'hw:Adapter', 'audio.channels': 12 }),
    sinkNode(4, 'alsa_output.fpp_card6'),
    sinkNode(5, '', {}),
    { id: 6, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'fppd_stream_1', 'media.class': 'Stream/Output/Audio' } } },
    { id: 7, type: 'PipeWire:Interface:Core', info: {} },
  ]);
  standInPactl([
    'alsa_output.usb-Vendor_UsbById-00.analog-stereo',
    'alsa_output.platform-pathbase.analog-stereo',
    'alsa_output.platform-pathexact-audio.iec958-stereo',
    'alsa_output.fpp_card5',
  ], [
    // Nothing to guess from.
    pactlCard('platform-lost', ['off: Off (sinks: 0, sources: 0)', 'Active Profile: off']),
    pactlCard('platform-profile', [
      'output:hdmi-surround: Digital Surround 5.1 (HDMI) Output (sinks: 0, sources: 0, priority: 100, available: no)',
      'output:hdmi-stereo: Digital Stereo (HDMI) Output (sinks: 1, sources: 0, priority: 5900, available: yes)',
      'Active Profile: output:hdmi-stereo',
    ]),
    // No output profiles (a disconnected HDMI port, a USB card set to off):
    // the one it would have is guessed from its name.
    pactlCard('platform-hd.hdmi', ['pro-audio: Pro Audio (sinks: 1, sources: 0)', 'Active Profile: pro-audio']),
    pactlCard('usb-guess', ['off: Off (sinks: 0, sources: 0)', 'Active Profile: off']),
  ].join(''));
  devLinks('by-id', { 'usb-Vendor_UsbById-00': 2 });
  devLinks('by-path', { 'platform-pathbase-audio': 3, 'platform-pathexact-audio': 4, 'platform-profile': 7,
    'platform-hd.hdmi': 8, 'usb-guess-audio': 9, 'platform-lost': 10 });
  standInCommand('amixer', `[ "$2" = 0 ] || exit 1\necho "Simple mixer control 'PCM',0"\necho "Simple mixer control 'Master',0"\n`);
  writeFile(`${CONFIG}/audio-card-aliases.json`, { aliases: { Lost: ' Porch ', Raw: '' } });

  const cards: Card[] = await (await request.get('/api/pipewire/audio/cards')).json();
  const byId = Object.fromEntries(cards.map((c) => [c.cardId, c]));
  expect(cards.map((c) => c.cardId)).toEqual(ids.slice(0, 12));
  expect(Object.fromEntries(cards.map((c) => [c.cardId, c.pwNodeName]))).toEqual({
    Raw: 'alsa_output.platform-raw.analog-stereo',
    Adapter: 'fpp_alsa_adapter',
    UsbById: 'alsa_output.usb-Vendor_UsbById-00.analog-stereo',
    PathBase: 'alsa_output.platform-pathbase.analog-stereo',
    PathExact: 'alsa_output.platform-pathexact-audio.iec958-stereo',
    Legacy: 'alsa_output.fpp_card5',
    LegacyDump: 'alsa_output.fpp_card6',
    Profile: 'alsa_output.platform-profile.hdmi-stereo',
    Hdmi: 'alsa_output.platform-hd.hdmi.hdmi-stereo',
    UsbGuess: 'alsa_output.usb-guess.analog-stereo',
    Lost: '',
    Dac8x: '',
  });

  expect(byId.Raw).toEqual({
    cardNum: 0, cardId: 'Raw', cardName: 'Raw Card', device: 0, deviceName: 'Raw PCM',
    channels: 6, mixerControls: ['PCM', 'Master'], alsaPath: 'hw:0', byPath: '', byId: '',
    pwNodeName: 'alsa_output.platform-raw.analog-stereo', alias: '',
  });
  // The sink's channels count, up to 7.1; a USB card's own playback altsets;
  // a known 8-channel I2S card; otherwise stereo.
  expect(Object.fromEntries(cards.map((c) => [c.cardId, c.channels]))).toMatchObject({
    Adapter: 8, UsbById: 4, PathBase: 2, Dac8x: 8,
  });
  expect(byId.UsbById).toMatchObject({ byId: 'usb-Vendor_UsbById-00', byPath: '', mixerControls: [] });
  expect(byId.Lost).toMatchObject({ byPath: 'platform-lost', alias: 'Porch' });
});

test('the enabled AES67, Opus RTP and VBAN senders are offered as cards too', async ({ request }) => {
  writeFile(`${CONFIG}/pipewire-aes67-instances.json`, { instances: [
    { id: 1, name: 'Stage Feed', enabled: true, mode: 'send', channels: 8, multicastIP: '239.69.0.1', port: 5010 },
    { id: 2, name: 'Return', enabled: true, mode: 'receive' },
    { id: 3, name: 'Spare', enabled: false, mode: 'send' },
    { id: 4, name: 'Both Ways', enabled: true, mode: 'both' },
  ] });
  writeFile(`${CONFIG}/pipewire-opus-rtp-instances.json`, { instances: [
    { id: 1, name: 'Opus Out', enabled: true, destIP: '10.0.0.9' }, // send, by default
    { id: 2, name: 'Opus In', enabled: true, mode: 'receive' },
    { id: 3, name: 'Opus Off' },
  ] });
  writeFile(`${CONFIG}/pipewire-vban-instances.json`, { instances: [
    { id: 1, name: 'Listen', enabled: true }, // receive, by default
    { id: 2, name: 'Desk', enabled: true, mode: 'send', channels: 1, destIP: '10.0.0.5', port: 6981 },
    { id: 3, name: 'Off', enabled: false, mode: 'send' },
  ] });
  // A sender found running is given the name PipeWire has for it.
  standInPactl(['aes67_both_ways_send.0', 'opusrtp_opus_out_send-2', 'vban_desk_send']);

  const cards: Card[] = await (await request.get('/api/pipewire/audio/cards')).json();
  expect(cards).toEqual([
    { cardNum: -1, cardId: 'aes67_1', cardName: 'Stage Feed (AES67 Send)', device: 0, deviceName: 'AES67 RTP Sink',
      channels: 8, mixerControls: [], alsaPath: '', byPath: '', byId: '', pwNodeName: 'aes67_stage_feed_send',
      isAES67: true, aes67InstanceId: 1, multicastIP: '239.69.0.1', port: 5010 },
    expect.objectContaining({ cardId: 'aes67_4', channels: 2, pwNodeName: 'aes67_both_ways_send.0', multicastIP: '', port: 5004 }),
    { cardNum: -1, cardId: 'opusrtp_1', cardName: 'Opus Out (Opus RTP Send)', device: 0, deviceName: 'Opus RTP Sink',
      channels: 2, mixerControls: [], alsaPath: '', byPath: '', byId: '', pwNodeName: 'opusrtp_opus_out_send-2',
      isOpusRTP: true, opusrtpInstanceId: 1, destIP: '10.0.0.9', port: 5005 },
    { cardNum: -1, cardId: 'vban_2', cardName: 'Desk (VBAN Send)', device: 0, deviceName: 'VBAN Sink',
      channels: 1, mixerControls: [], alsaPath: '', byPath: '', byId: '', pwNodeName: 'vban_desk_send',
      isVBAN: true, vbanInstanceId: 2, destIP: '10.0.0.5', port: 6981 },
  ]);
});
