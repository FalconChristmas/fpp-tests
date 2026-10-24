import { inPlayer } from './container';
import { writeFile } from './pw-helpers';

// Sound cards for the PHP that lists them.  The container has no sound card
// and /proc/asound cannot be faked in it, so the API functions that read
// /proc/asound are run here by PHP's CLI (the same controller code Apache
// runs, loaded the way api/index.php loads it) with PHP's file wrapper
// swapped for one that reads /proc/asound/* from a tree written for the
// test.  Everything else -- other files, exec(), the real PipeWire -- is
// untouched.  aplay, which older code ran instead, is a stand-in that prints
// the same cards, in English or (as on a system installed in French) in
// French unless asked for the C locale.

const ROOT = '/tmp/fpp-tests-asound';
const HARNESS = '/tmp/fpp-tests-asound.php';
const APLAY = '/usr/local/bin/aplay';

export type Card = { num: number; id: string; driver: string; name: string; longName: string; pcm?: string };

// A Pi's headphone jack, a USB sound card, and a USB MIDI keyboard: a card
// in /proc/asound/cards with no PCM device at all.
export const CARDS: Card[] = [
  { num: 0, id: 'Headphones', driver: 'bcm2835_headpho', name: 'bcm2835 Headphones', longName: 'bcm2835 Headphones',
    pcm: 'bcm2835 Headphones : bcm2835 Headphones : playback 8' },
  { num: 1, id: 'S3', driver: 'USB-Audio', name: 'Sound Blaster Play! 3',
    longName: 'Creative Technology Ltd Sound Blaster Play! 3 at usb-xhci-hcd.0-1.2, full speed',
    pcm: 'USB Audio : USB Audio : playback 1 : capture 1' },
  { num: 2, id: 'Keys', driver: 'USB-Audio', name: 'USB MIDI Keyboard',
    longName: 'fpp-tests USB MIDI Keyboard at usb-xhci-hcd.0-1.3, full speed' },
];

const PHP = String.raw`<?php
// fpp-tests: run one API controller function with /proc/asound read from $argv[1].
$GLOBALS['fppTestsRoot'] = $argv[1];
$fn = $argv[2];
$args = isset($argv[3]) ? json_decode($argv[3], true) : array();
chdir('/opt/fpp/www/api');
require_once 'lib/limonade.php';
$skipJSsettings = 1;
require_once '../config.php';
require_once '../common.php';
foreach (glob('controllers/*.php') as $c) require_once $c;

class FppTestsAsound {
    public $context;
    private $h;
    private $d;
    static function map($p) {
        return strpos($p, '/proc/asound') === 0 ? $GLOBALS['fppTestsRoot'] . $p : $p;
    }
    static function real($f) {
        stream_wrapper_restore('file');
        try { return $f(); } finally { stream_wrapper_unregister('file'); stream_wrapper_register('file', 'FppTestsAsound'); }
    }
    function stream_open($path, $mode, $options, &$opened) {
        $this->h = self::real(function () use ($path, $mode) { return @fopen(self::map($path), $mode); });
        return $this->h !== false;
    }
    function stream_read($n) { return fread($this->h, $n); }
    function stream_write($data) { return fwrite($this->h, $data); }
    function stream_eof() { return feof($this->h); }
    function stream_tell() { return ftell($this->h); }
    function stream_seek($o, $w) { return fseek($this->h, $o, $w) === 0; }
    function stream_flush() { return fflush($this->h); }
    function stream_close() { fclose($this->h); }
    function stream_stat() { return fstat($this->h); }
    function stream_lock($op) { return flock($this->h, $op); }
    function stream_truncate($n) { return ftruncate($this->h, $n); }
    function stream_set_option($o, $a, $b) { return false; }
    function stream_metadata($p, $o, $v) {
        return self::real(function () use ($p, $o, $v) {
            $p = self::map($p);
            switch ($o) {
                case STREAM_META_TOUCH: return touch($p);
                case STREAM_META_OWNER_NAME: case STREAM_META_OWNER: return chown($p, $v);
                case STREAM_META_GROUP_NAME: case STREAM_META_GROUP: return chgrp($p, $v);
                case STREAM_META_ACCESS: return chmod($p, $v);
            }
            return false;
        });
    }
    function url_stat($p, $flags) { return self::real(function () use ($p) { return @stat(self::map($p)); }); }
    function unlink($p) { return self::real(function () use ($p) { return @unlink(self::map($p)); }); }
    function rename($a, $b) { return self::real(function () use ($a, $b) { return @rename(self::map($a), self::map($b)); }); }
    function mkdir($p, $m, $o) { return self::real(function () use ($p, $m, $o) { return @mkdir(self::map($p), $m, ($o & STREAM_MKDIR_RECURSIVE) != 0); }); }
    function rmdir($p, $o) { return self::real(function () use ($p) { return @rmdir(self::map($p)); }); }
    function dir_opendir($p, $o) { $this->d = self::real(function () use ($p) { return @opendir(self::map($p)); }); return $this->d !== false; }
    function dir_readdir() { return readdir($this->d); }
    function dir_rewinddir() { rewinddir($this->d); return true; }
    function dir_closedir() { closedir($this->d); return true; }
}
stream_wrapper_unregister('file');
stream_wrapper_register('file', 'FppTestsAsound');

$out = call_user_func_array($fn, $args);
stream_wrapper_restore('file');
// A json() answer is JSON already; anything else (a conf, an array) is encoded.
echo "\n@@fpp-tests@@" . (getenv('FPP_TESTS_ENCODE') ? json_encode($out) : $out);
`;

// Write /proc/asound/cards and /proc/asound/pcm for `cards` under the fake root.
export function fakeCards(cards: Card[] = CARDS) {
  const lines = cards.map((c) => `${String(c.num).padStart(2)} [${c.id.padEnd(15)}]: ${c.driver} - ${c.name}\n` +
    `${' '.repeat(22)}${c.longName}\n`).join('');
  writeFile(`${ROOT}/proc/asound/cards`, lines);
  writeFile(`${ROOT}/proc/asound/pcm`, cards.filter((c) => c.pcm)
    .map((c) => `${String(c.num).padStart(2, '0')}-00: ${c.pcm}\n`).join(''));
  for (const c of cards) writeFile(`${ROOT}/proc/asound/card${c.num}/id`, c.id + '\n');
}

// An aplay that lists `cards`' playback devices for -l; 'fr' answers in
// French unless the C locale is asked for, as aplay does on a French system.
export function standInAplay(cards: Card[] = CARDS, lang: 'en' | 'fr' = 'en') {
  const en = ['**** List of PLAYBACK Hardware Devices ****', ...cards.filter((c) => c.pcm && / playback /.test(c.pcm))
    .flatMap((c) => { const [devId, devName] = c.pcm!.split(' : ');
      return [`card ${c.num}: ${c.id} [${c.name}], device 0: ${devId} [${devName}]`, '  Subdevices: 1/1', '  Subdevice #0: subdevice #0']; })];
  const fr = en.map((l) => l.replace('**** List of PLAYBACK Hardware Devices ****', '**** Liste des Périphériques Matériels PLAYBACK ****')
    .replace(/^card /, 'carte ').replace(', device ', ', périphérique ').replace('Subdevices', 'Sous-périphériques')
    .replace('Subdevice #0: subdevice #0', 'Sous-périphérique #0 : subdevice #0'));
  writeFile('/tmp/fpp-tests-aplay-en.txt', en.join('\n') + '\n');
  writeFile('/tmp/fpp-tests-aplay-fr.txt', fr.join('\n') + '\n');
  writeFile(APLAY, `#!/bin/sh
# fpp-tests stand-in: the test's sound cards
[ "$1" = -l ] || exit 1
loc=\${LC_ALL:-\${LC_MESSAGES:-\${LANG:-${lang === 'fr' ? 'fr_FR.UTF-8' : 'C'}}}}
case "$loc" in C|C.*|POSIX) cat /tmp/fpp-tests-aplay-en.txt ;; *) cat /tmp/fpp-tests-aplay-${lang}.txt ;; esac
`);
  inPlayer('chmod', '755', APLAY);
}

// Call an API controller function (by name, with JSON-able arguments) against
// the fake /proc/asound; what it returned, parsed as JSON.
export function callApi(fn: string, ...args: unknown[]): any {
  return run(fn, args, false);
}

// The same for a function that returns a plain PHP value (a conf, an array).
export function callPhp(fn: string, ...args: unknown[]): any {
  return run(fn, args, true);
}

function run(fn: string, args: unknown[], encode: boolean): any {
  writeFile(HARNESS, PHP);
  const out = inPlayer('env', `FPP_TESTS_ENCODE=${encode ? 1 : ''}`, 'php', HARNESS, ROOT, fn, JSON.stringify(args));
  const i = out.lastIndexOf('@@fpp-tests@@');
  if (i < 0) throw new Error(`${fn} did not return:\n${out}`);
  return JSON.parse(out.slice(i + '@@fpp-tests@@'.length));
}

export function cleanupAsound() {
  inPlayer('rm', '-rf', ROOT, HARNESS, APLAY, '/tmp/fpp-tests-aplay-en.txt', '/tmp/fpp-tests-aplay-fr.txt');
}
