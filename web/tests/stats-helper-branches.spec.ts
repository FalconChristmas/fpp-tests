import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingFile, MEDIA, php, writeFile } from './privacy-helpers';

// Branches of the usage-statistics collectors that no page needs to visit.
// The collectors are plain PHP: running them in the player with a few crafted
// config files reaches the same code as /api/statistics/usage, and lets the
// assertions say what the derived numbers mean.

test.skip(!container, 'runs PHP inside the run-web.sh container');

const ROWS = '/tmp/fpp-tests-stats-rows';
const SHAPE = '/tmp/fpp-tests-stats-shape';
const CAPE = `${MEDIA}/tmp/cape-info.json`;

function statsPhp(code: string): any {
  const out = php(`
require_once '/opt/fpp/www/api/controllers/stats.php';
${code}
`);
  return JSON.parse(out.trim().split('\n').pop()!);
}

test.afterEach(() => inPlayer('rm', '-rf', ROWS, SHAPE));

test('peer addresses are classified by scope, UDP targets by address form', () => {
  const out = statsPhp(`
echo json_encode(array(
  'classes' => array_map('stats_addressClass', array('', '192.0.2.10', '169.254.3.4', 'fe80::1', 'fc00::1', 'fd12::1', '::1', '::', '2001:db8::1')),
  'stacks' => array(stats_stackOf(array('ipv4')), stats_stackOf(array('ipv6-ula')), stats_stackOf(array('ipv4', 'ipv6-global')), stats_stackOf(array('ipv6-linklocal'))),
  'forms' => array_map('stats_addressForm', array('192.0.2.10', '224.0.0.1', '255.255.255.255', '192.0.2.255', '::1', 'fpp-tests-peer.invalid')),
));
`);
  expect(out.classes).toEqual(['unknown', 'ipv4', 'ipv4-linklocal', 'ipv6-linklocal', 'ipv6-ula', 'ipv6-ula', 'ipv6-loopback', 'ipv6-loopback', 'ipv6-global']);
  expect(out.stacks).toEqual(['v4', 'v6', 'dual', 'none']);
  expect(out.forms).toEqual(['ipv4', 'ipv4_multicast', 'ipv4_broadcast', 'ipv4_broadcast', 'ipv6', 'hostname']);
});

test('output config rows count flat rows, universes and the shape of UDP targets', () => {
  inPlayer('mkdir', '-p', ROWS);
  const put = (name: string, value: unknown) => writeFile(`${ROWS}/${name}.json`, JSON.stringify(value));
  put('universeInputs', { channelInputs: [{ enabled: 1, universes: [
    { active: 1, type: 0, universeCount: 3, channelCount: 512 },
    { active: 1, type: 4, channelCount: 100 }, // DDP: channelCount is already the span
    { active: 0, type: 0, universeCount: 2, channelCount: 512 },
    { active: 1, type: 5, channelCount: 20, universeCount: 9 },
    { active: 1, channelCount: 10 }, // no type or count: one universe
  ] }] });
  put('universeOutputs', { channelOutputs: [
    { enabled: 1, threaded: 0, type: 5, universes: [
      { active: 1, type: 0, universeCount: 2, channelCount: 512, address: '192.0.2.10', priority: 1, deDuplicate: 1, monitor: 1 },
      { active: 1, type: 4, channelCount: 100, address: '192.0.2.10' }, // same target, second row
      { active: 1, type: 0, universeCount: 1, channelCount: 512, address: '239.255.0.1' },
      { active: 1, type: 0, universeCount: 1, channelCount: 512, address: '192.0.2.255' },
      { active: 1, type: 0, universeCount: 1, channelCount: 512, address: 'fpp-tests-peer.invalid' },
      { active: 1, type: 0, universeCount: 1, channelCount: 512 }, // empty: multicast
      { active: 0, type: 0, universeCount: 1, channelCount: 512 },
    ] },
    { universes: [{ active: 1, type: 0, universeCount: 1, channelCount: 128, address: 'editor.invalid' }] },
  ] });
  put('channelOutputsJSON', { channelOutputs: [{ enabled: 1, type: 'ledPanels', panelWidth: 64, panelHeight: 32, panels: [{}, {}] }] });
  put('co-other', { channelOutputs: [
    { enabled: 1, type: 'dmx', channelCount: 512 },
    { enabled: 1, type: 'dmx', channelCount: 128 },
    { enabled: 0, type: 'pixelStrings', channelCount: 256 },
  ] });
  put('co-pixelStrings', { channelOutputs: [{ type: 'ws2811', enabled: 1, outputCount: 6, outputs: [
    { protocol: 'ws2811', virtualStrings: [{ pixelCount: 25 }] },
    { protocol: 'ws2811', virtualStrings: [{ pixelCount: 75 }] },
    { protocol: 'ws2811', virtualStrings: [{ pixelCount: 150 }] },
    { protocol: 'ws2811', virtualStrings: [{ pixelCount: 300 }] },
    { protocol: 'ws2812', virtualStrings: [{ pixelCount: 500 }] },
    { protocol: 'ws2811' },
  ] }] });
  put('co-pwm', { channelOutputs: [{ type: 'pwm', enabled: 1, frequency: 1000, outputs: [
    { type: 'LED' }, { type: 'Servo' }, { type: 'LED' },
  ] }] });

  const out = statsPhp(`
$settings['universeInputs'] = '${ROWS}/universeInputs.json';
$settings['universeOutputs'] = '${ROWS}/universeOutputs.json';
$settings['channelOutputsJSON'] = '${ROWS}/channelOutputsJSON.json';
$settings['co-other'] = '${ROWS}/co-other.json';
$settings['co-pwm'] = '${ROWS}/co-pwm.json';
echo json_encode(array(
  'in' => stats_universe_in(),
  'out' => stats_universe_out(),
  'panel' => stats_panel_out(),
  'other' => stats_other_out(),
  'pixel' => stats_pixel_or_pi('${ROWS}/co-pixelStrings.json'),
  'pwm' => stats_pwm_out(),
));
`);

  expect(out.in).toMatchObject({ universeCount: 4, rowCount: 5, activeRowCount: 4, channelCount: 1666, countsVersion: 2 });
  expect(out.in.rowType).toEqual({ type_0: 1, type_4: 1, type_5: 1, type_unknown: 1 });
  expect(out.out).toMatchObject({ universeCount: 7, rowCount: 8, activeRowCount: 7, channelCount: 3300, deDupeCount: 1, monitorCount: 1, countsVersion: 2 });
  expect(out.out.rowType).toEqual({ type_0: 6, type_4: 1 });
  expect(out.out.priority).toEqual({ priority_1: 1 });
  expect(out.out.destType.unknown).toMatchObject({ rows: 6, channels: 2788, protocol: { type_0: 5, type_4: 1 } });
  expect(out.out.destType.multicast).toMatchObject({ rows: 1, channels: 512 });
  expect(out.out.targets).toMatchObject({
    count: 3,
    undiscovered: { targets: 3, rows: 4 },
    nonUnicast: { targets: 2, rows: 2 },
    form: { ipv4: 1, hostname: 2, ipv4_multicast: 1, ipv4_broadcast: 1 },
    undiscoveredForm: { ipv4: 1, hostname: 2 },
    rowsPerTarget: { rows_2: 1, rows_1: 2 },
    maxRowsPerTarget: 2,
  });
  expect(out.panel).toMatchObject({ enabled: 1, panelWidth: 64, panelHeight: 32, panelCount: 2 });
  expect(out.other).toMatchObject({ types: ['dmx', 'dmx'], typeCounts: { dmx: { cnt: 2, channels: 640 } } });
  expect(out.pixel).toMatchObject({
    pixelCount: 1050, usedPortCount: 5, virtualStringCount: 5,
    protocols: { ws2811: 5, ws2812: 1 },
    portPixelBuckets: { px_0: 1, 'px_1-50': 1, 'px_51-100': 1, 'px_101-200': 1, 'px_201-400': 1, 'px_401+': 1 },
  });
  expect(out.pwm).toMatchObject({ enabled: 1, frequency: 1000, types: { LED: 2, Servo: 1 } });
});

test('sequence shape buckets step times, channel counts, versions and playlist lengths', () => {
  inPlayer('mkdir', '-p', SHAPE);
  writeFile(`${SHAPE}/empty.json`, JSON.stringify({ leadIn: [], mainPlaylist: [], leadOut: [] }));
  writeFile(`${SHAPE}/three.json`, JSON.stringify({ mainPlaylist: [{}, {}, {}] }));
  writeFile(`${SHAPE}/ten.json`, JSON.stringify({ mainPlaylist: Array(10).fill({}) }));
  writeFile(`${SHAPE}/thirty.json`, JSON.stringify({ mainPlaylist: Array(30).fill({}) }));
  writeFile(`${SHAPE}/sixty.json`, JSON.stringify({ mainPlaylist: Array(60).fill({}) }));
  writeFile(`${SHAPE}/broken.json`, 'not json');

  // The collector reads the sequence list and each meta over localhost.  A
  // stand-in for that stream supplies the headers the buckets are built from,
  // including CompressionType, which fsequtils -j does not currently emit.
  const out = statsPhp(`
class FppTestsStatsHttp {
  public $context;
  private $body;
  private $at = 0;
  function stream_open($path, $mode, $options, &$opened) {
    $metas = array(
      array('StepTime' => 25, 'ChannelCount' => 64, 'Version' => '2.0', 'CompressionType' => 0, 'NumFrames' => 10),
      array('StepTime' => 50, 'ChannelCount' => 2000, 'Version' => '2.0', 'CompressionType' => 1, 'NumFrames' => 20),
      array('StepTime' => 25, 'ChannelCount' => 20000, 'Version' => '1.0', 'CompressionType' => 2, 'NumFrames' => 30),
      array('StepTime' => 50, 'ChannelCount' => 100000, 'Version' => '2.0', 'CompressionType' => 0, 'NumFrames' => 40),
      array('StepTime' => 25, 'ChannelCount' => 400000, 'Version' => '2.0', 'CompressionType' => 1, 'NumFrames' => 50),
      array('StepTime' => 50, 'ChannelCount' => 600000, 'Version' => '2.0', 'CompressionType' => 0, 'NumFrames' => 60),
    );
    $path = parse_url($path, PHP_URL_PATH);
    $many = !empty($GLOBALS['FPP_TESTS_SHAPE_MANY']);
    if ($path === '/api/sequence') {
      $names = array();
      $n = $many ? 251 : count($metas);
      for ($i = 0; $i < $n; $i++) { $names[] = 'fpp-tests-shape-' . $i; }
      $this->body = json_encode($names);
    } else if (preg_match('#^/api/sequence/fpp-tests-shape-(\\d+)/meta$#', $path, $m)) {
      if ($many && $m[1] == '0') {
        $this->body = 'not json';
      } else if ($many && $m[1] == '1') {
        $this->body = json_encode(array('StepTime' => 25)); // no header fields to bucket
      } else {
        $this->body = json_encode($metas[intval($m[1]) % count($metas)]);
      }
    } else {
      $this->body = 'false';
    }
    $this->at = 0;
    return true;
  }
  function stream_read($count) { $r = substr($this->body, $this->at, $count); $this->at += strlen($r); return $r; }
  function stream_eof() { return $this->at >= strlen($this->body); }
  function stream_stat() { return array(); }
}
stream_wrapper_unregister('http');
stream_wrapper_register('http', 'FppTestsStatsHttp');
$playlistDirectory = '${SHAPE}';
$first = stats_getSequenceShape();
$GLOBALS['FPP_TESTS_SHAPE_MANY'] = true;
$second = stats_getSequenceShape();
stream_wrapper_restore('http');
echo json_encode(array(
  'first' => $first,
  'second' => array('truncated' => isset($second['truncated']) ? $second['truncated'] : false,
                    'sequences' => $second['sequences'], 'read' => $second['read']),
));
`);
  expect(out.first.sequences).toBe(6);
  expect(out.first.read).toBe(6);
  expect(out.first.stepTime).toEqual({ ms_25: 3, ms_50: 3 });
  expect(out.first.channelCountBuckets).toEqual({
    'ch_0-1k': 1, 'ch_1k-8k': 1, 'ch_8k-32k': 1, 'ch_32k-128k': 1, 'ch_128k-512k': 1, 'ch_512k+': 1,
  });
  expect(out.first.fseqVersion).toEqual({ '2.0': 5, '1.0': 1 });
  expect(out.first.compression).toEqual({ type_0: 3, type_1: 2, type_2: 1 });
  expect(out.first.totalFrames).toBe(210);
  expect(out.first.playlists).toBe(5);
  expect(out.first.playlistLengthBuckets).toEqual({ len_0: 1, 'len_1-5': 1, 'len_6-20': 1, 'len_21-50': 1, 'len_51+': 1 });
  expect(out.second.truncated).toBe(true);
  expect(out.second.sequences).toBe(251);
  expect(out.second.read).toBeLessThan(250); // two broken metas are skipped
});

test('missing or empty output config files are reported rather than assumed empty', () => {
  inPlayer('mkdir', '-p', ROWS);
  writeFile(`${ROWS}/empty.json`, '{}');
  const out = statsPhp(`
$none = '${ROWS}/does-not-exist.json';
$settings['universeInputs'] = $none;
$settings['universeOutputs'] = $none;
$settings['channelOutputsJSON'] = $none;
$settings['co-other'] = $none;
$settings['co-pwm'] = $none;
$missing = array(
  'in' => stats_universe_in(), 'out' => stats_universe_out(), 'panel' => stats_panel_out(),
  'other' => stats_other_out(), 'pwm' => stats_pwm_out(), 'pixel' => stats_pixel_or_pi($none),
);
$settings['universeInputs'] = '${ROWS}/empty.json';
$settings['universeOutputs'] = '${ROWS}/empty.json';
$settings['channelOutputsJSON'] = '${ROWS}/empty.json';
$settings['co-other'] = '${ROWS}/empty.json';
$settings['co-pwm'] = '${ROWS}/empty.json';
$empty = array(
  'in' => stats_universe_in(), 'out' => stats_universe_out(), 'panel' => stats_panel_out(),
  'other' => stats_other_out(), 'pwm' => stats_pwm_out(), 'pixel' => stats_pixel_or_pi('${ROWS}/empty.json'),
);
echo json_encode(array('missing' => $missing, 'empty' => $empty));
`);
  for (const k of ['in', 'out', 'panel']) {
    expect(out.missing[k].file).toBe(`${ROWS}/does-not-exist.json`);
    expect(out.missing[k]).not.toHaveProperty('universeCount');
    expect(out.empty[k].file).toBe(`${ROWS}/empty.json`);
  }
  for (const k of ['other', 'pwm', 'pixel']) {
    expect(out.missing[k].status).toBe('File not found');
    expect(out.empty[k].status).toBe('ChannelOutputs not found');
  }
});

test('generating the whole payload runs every collector and writes the JSON', async () => {
  // With no cape, /api/cape answers 404 ("No Cape!") and the collector warns
  // on that benign response.  Seed a cape as the other cape specs do: the
  // payload then also shows what it keeps out of a cape record.
  inPlayer('mkdir', '-p', `${MEDIA}/tmp`);
  await keepingFile(CAPE, async () => {
    writeFile(CAPE, JSON.stringify({
      id: 'FPP-TEST-CAPE', name: 'Test Cape', designer: 'FPP Tests',
      serialNumber: 'SECRET-SERIAL', verifiedKeyId: 'tk',
      vendor: { name: 'Test Vendor', url: 'https://example.invalid' },
    }));
    inPlayer('mkdir', '-p', ROWS);
    const out = statsPhp(`
$file = '${ROWS}/usage.json';
stats_generate($file);
$obj = json_decode(file_get_contents($file), true);
echo json_encode(array(
  'wrote' => file_exists($file),
  'keys' => array_keys($obj),
  'capeInfo' => $obj['capeInfo'],
  'meminfoAvailable' => isset($obj['memory']['meminfoAvailable']) ? $obj['memory']['meminfoAvailable'] : null,
  'stack' => isset($obj['network']['stack']) ? $obj['network']['stack'] : null,
));
`);
    expect(out.wrote).toBe(true);
    expect(out.keys).toEqual(expect.arrayContaining([
      'uuid', 'systemInfo', 'capeInfo', 'outputProcessors', 'files', 'models', 'multisync',
      'multisyncShape', 'plugins', 'schedule', 'settings', 'network', 'memory', 'universe_input',
      'output_e131', 'output_panel', 'output_other', 'output_pixel_pi', 'output_pixel_bbb',
      'output_pwm', 'timezone', 'sequenceShape', 'installAge', 'consent',
    ]));
    expect(out.capeInfo).toMatchObject({
      id: 'FPP-TEST-CAPE', name: 'Test Cape', designer: 'FPP Tests', verifiedKeyId: 'tk', vendor: 'Test Vendor',
    });
    expect(out.capeInfo).not.toHaveProperty('serialNumber');
    expect(out.meminfoAvailable).toBe(true); // /proc/meminfo on Linux
    expect(['v4', 'v6', 'dual', 'none']).toContain(out.stack);
  });
});

test('MultiSync peers are deduplicated by identity without sending an address', () => {
  const out = statsPhp(`
$uuid = '123e4567-e89b-12d3-a456-426614174000';
$injected = array('systems' => array(
  array('uuid' => $uuid, 'address' => '192.0.2.10', 'hostname' => 'fpp-tests-peer.local', 'type' => 'FPP', 'version' => '10.0',
        'systemInfo' => array('Platform' => 'Linux', 'address' => 'private'),
        'capeInfo' => array('present' => true, 'sendStats' => 0, 'id' => 'SECRET', 'name' => 'Cape')),
  array('uuid' => $uuid, 'address' => '2001:db8::1', 'type' => 'FPP'),
  array('uuid' => 'MAC:00:11:22:33:44:55', 'address' => '192.0.2.11', 'type' => 'Falcon'),
  array('uuid' => 'Failed', 'address' => '192.0.2.12', 'type' => 'WLED'),
  array('address' => '192.0.2.13', 'type' => 'FPP'),
));
echo json_encode(stats_multiSyncCollect($injected));
`);
  expect(out.shape).toMatchObject({ rows: 5, devices: 4, multiAddress: 1, addressesPerDevice: { 2: 1, 1: 3 }, stacks: { dual: 1, v4: 3 } });
  expect(out.peers[0]).toMatchObject({ uuid: '123e4567-e89b-12d3-a456-426614174000', addressCount: 2, ipv4Count: 1, ipv6Count: 1, stack: 'dual' });
  expect(out.peers[0].capeInfo).toEqual({ present: true });
  expect(out.peers[0].systemInfo).toEqual({ platform: 'Linux' });
  expect(out.peers[1].uuid).toMatch(/^MH-[0-9a-f]{16}$/);
  expect(out.peers[2].uuid).toMatch(/^X-[0-9a-f]{16}$/);
  expect(out.peers[3].uuid).toMatch(/^X-[0-9a-f]{16}$/);
  for (const p of out.peers) {
    expect(p).not.toHaveProperty('address');
    expect(p).not.toHaveProperty('hostname');
  }
});
