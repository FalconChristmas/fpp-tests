import { test, expect } from './fixtures';
import { container } from './container';
import { php } from './privacy-helpers';

// The usage statistics payload also carries what the player's status reports
// about its sensors.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('the system block of the payload carries the status sensors', () => {
  // Regression: f3b7203db.  stats_getSystemInfo() copied the fppd status, mode
  // and uptime from /api/system/status but not "sensors", so the project could
  // not see the temperature ranges or the 5V vs 12V supplies players run at.
  // This player has no sensors, so the status it reads is a canned answer
  // (an http stream wrapper in the php-cli run).
  const out = php(`
class FakeStatus {
    public $context; private $pos = 0; private $body;
    function stream_open($path, $mode, $opts, &$opened) {
        $this->body = json_encode(array('MQTT' => array('configured' => false), 'fppd' => 'running',
            'mode_name' => 'player', 'uptimeTotalSeconds' => 1234, 'wifi' => array(),
            'sensors' => array(array('label' => 'CPU: ', 'value' => 51.5, 'valueType' => 'Temperature'),
                               array('label' => '5V: ', 'value' => 4.9, 'valueType' => 'Voltage'))));
        return true;
    }
    function stream_read($n) { $r = substr($this->body, $this->pos, $n); $this->pos += strlen($r); return $r; }
    function stream_eof() { return $this->pos >= strlen($this->body); }
    function stream_stat() { return array(); }
}
stream_wrapper_unregister('http');
stream_wrapper_register('http', 'FakeStatus');
require_once '/opt/fpp/www/api/controllers/stats.php';
echo json_encode(stats_getSystemInfo());
`);
  const info = JSON.parse(out.trim().split('\n').pop()!);
  // The control: the rest of the block is built from the same answer.
  expect(info.fppdMode).toBe('player');
  expect(info.fppdUptimeSeconds).toBe(1234);
  expect(info.sensors, JSON.stringify(info)).toEqual([
    { label: 'CPU: ', value: 51.5, valueType: 'Temperature' },
    { label: '5V: ', value: 4.9, valueType: 'Voltage' },
  ]);
});
