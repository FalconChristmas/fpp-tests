import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { php, writeFile } from './privacy-helpers';

// The ALSA-facing helpers in pipewire.php read what aplay and /proc say about
// a sound card.  A stand-in aplay in the player gives those parsers the outputs
// a real card would, so their branches can be reached and their answers
// checked without any hardware.

test.skip(!container, 'puts a stand-in aplay in the run-web.sh container');

const BIN = '/tmp/fpp-tests-pw-helpers';

function fakeAplay() {
  inPlayer('mkdir', '-p', BIN);
  writeFile(`${BIN}/aplay`, `#!/bin/sh
case "$FPP_TESTS_APLAY" in
  rates) echo '  RATE: { 44100 48000 }' ;;
  range) echo '  RATE: [8000 192000]' ;;
  single) echo '  RATE: 96000' ;;
  exact) echo 'Playing raw data' ;;
  refined) echo 'Playing raw data'
          echo 'warning: rate is not accurate (requested = 44100Hz, got = 48000Hz)' ;;
  widenDown) case "$*" in
      *S16_LE*) echo 'Playing raw data' ;;
      *) echo 'warning: rate is not accurate (requested = 44100Hz, got = 22050Hz)' ;;
    esac ;;
  fail) echo 'Sample format non available'; exit 1 ;;
  hwparams) echo 'HW Params of device'
            echo 'FORMAT:  S32_LE'
            echo 'CHANNELS: 8' ;;
esac
exit 0
`);
  inPlayer('chmod', '755', `${BIN}/aplay`);
}

function pwPhp(code: string): any {
  const out = php(`
chdir('/opt/fpp/www/api');
require_once 'controllers/pipewire.php';
putenv('PATH=${BIN}:' . getenv('PATH'));
${code}
`);
  return JSON.parse(out.trim().split('\n').pop()!);
}

test.beforeEach(fakeAplay);
test.afterEach(() => inPlayer('rm', '-rf', BIN));

test('a card best rate comes from a discrete list, a range or a single rate', () => {
  const out = pwPhp(`
function rate($mode, $id, $allowed, $fallback) {
  putenv('FPP_TESTS_APLAY=' . $mode);
  return QueryAlsaCardBestRate($id, $allowed, $fallback);
}
echo json_encode(array(
  'badId' => rate('rates', 'hw:0;id', array(44100, 48000), 44100),
  'discrete' => rate('rates', 'Card0', array(44100, 96000), 44100),
  'range' => rate('range', 'Card0', array(44100, 96000), 44100),
  'graphClock' => rate('range', 'Card0', array(44100, 48000, 96000), 44100),
  'rangeHigh' => rate('range', 'Card0', array(96000, 192000), 44100),
  'single' => rate('single', 'Card0', array(96000, 48000), 44100),
  'silent' => rate('silent', 'Card0', array(48000), 44100),
  'unsupported' => rate('single', 'Card0', array(48000), 44100),
));
`);
  expect(out).toEqual({
    badId: 44100, discrete: 48000, range: 96000, graphClock: 48000, rangeHigh: 192000, single: 96000, silent: 44100,
    unsupported: 44100,
  });
});

test('a format probe reports the negotiated rate and tells refusal from refinement', () => {
  const out = pwPhp(`
function probe($mode, $fmt, $rate, $channels) {
  putenv('FPP_TESTS_APLAY=' . $mode);
  return PipeWireProbeFormatRate('hw:0', $fmt, $rate, $channels);
}
echo json_encode(array(
  'unknownFormat' => probe('exact', 'F32LE', 44100, 2),
  'exact' => probe('exact', 'S16LE', 44100, 2),
  'refined' => probe('refined', 'S32LE', 44100, 2),
  'refinedDown' => probe('widenDown', 'S32LE', 44100, 2),
  'refused' => probe('fail', 'S32LE', 44100, 2),
  'defaults' => probe('exact', 'S16LE', 0, 0),
));
`);
  expect(out).toEqual({ unknownFormat: 0, exact: 44100, refined: 48000, refinedDown: 22050, refused: 0, defaults: 44100 });
});

test('a wider format is offered only when it costs no sample rate', () => {
  const out = pwPhp(`
function best($mode, $fmt) {
  putenv('FPP_TESTS_APLAY=' . $mode);
  return PipeWireBestFormatForRate($fmt, 'hw:0', 44100, 2);
}
echo json_encode(array(
  'noWider' => best('exact', 'S16_LE'),
  'baselineRefused' => best('fail', 'S16_LE S32_LE'),
  'freeWiden' => best('exact', 'S16_LE S32_LE'),
  'costlyWiden' => best('widenDown', 'S16_LE S32_LE'),
  'noS16' => best('exact', 'S32_LE'),
  'noS16Refused' => best('fail', 'S32_LE'),
  'otherFallback' => best('fail', 'S24_LE'),
));
`);
  expect(out).toEqual({
    noWider: 'S16LE', baselineRefused: 'S16LE', freeWiden: 'S32LE', costlyWiden: 'S16LE',
    noS16: 'S32LE', noS16Refused: 'S32LE', otherFallback: 'S24_32LE',
  });
});

test('combine streams are found by target and HW params read from aplay', () => {
  const out = pwPhp(`
$objects = array(
  array('type' => 'PipeWire:Interface:Node', 'id' => 7, 'info' => array(
    'props' => array('node.name' => 'output.combine_A_target', 'node.target' => 'target'),
    'params' => array('Props' => array(array('channelVolumes' => array(1, 2, 3, 4)))))),
  array('type' => 'PipeWire:Interface:Node', 'id' => 8, 'info' => array(
    'props' => array('node.name' => 'combine_A', 'target.object' => 'target'))),
  array('type' => 'PipeWire:Interface:Sink', 'id' => 9, 'info' => array(
    'props' => array('node.name' => 'combine_A', 'node.target' => 'target'))),
);
putenv('FPP_TESTS_APLAY=hwparams');
$live = false;
$hw = PipeWireCardHwParams('Card0', 0, $live);
putenv('FPP_TESTS_APLAY=silent');
$liveNone = false;
$hwNone = PipeWireCardHwParams('Card0', -1, $liveNone);
$liveCard = false;
$hwCard = PipeWireCardHwParams('Card0', 0, $liveCard);
echo json_encode(array(
  'streams' => pw_find_combine_streams($objects, 'combine_A', 'target'),
  'notObjects' => pw_find_combine_streams('not an array', 'combine_A', 'target'),
  'noName' => pw_find_combine_streams($objects, '', 'target'),
  'wrongTarget' => pw_find_combine_streams($objects, 'combine_A', 'other'),
  'channels' => pw_node_channel_count($objects[0]),
  'defaultChannels' => pw_node_channel_count(array()),
  'hw' => array('text' => $hw, 'live' => $live),
  'hwNone' => array('text' => $hwNone, 'live' => $liveNone),
  'hwCard' => array('text' => $hwCard, 'live' => $liveCard),
));
`);
  expect(out.streams).toEqual({ 7: 4, 8: 2 }); // node ids, not the sink
  expect(out.notObjects).toEqual([]);
  expect(out.noName).toEqual([]);
  expect(out.wrongTarget).toEqual([]);
  expect(out.channels).toBe(4);
  expect(out.defaultChannels).toBe(2);
  expect(out.hw.text).toContain('HW Params of device');
  expect(out.hw.text).toContain('FORMAT:  S32_LE');
  expect(out.hw.live).toBe(false);
  expect(out.hwNone).toEqual({ text: '', live: false });
  expect(out.hwCard).toEqual({ text: '', live: false }); // no /proc/asound/card0
});
