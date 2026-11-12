import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// GET /api/pipewire/video/input-sources/v4l2-devices is the camera list of
// the Video Input Sources page: every /dev/video* node that v4l2-ctl says is
// a capture device, with its name, bus, anti-flicker setting and the sizes
// and frame rates it offers (www/api/controllers/pipewire.php GetV4L2Devices,
// GetV4L2DeviceModes).  The container has no cameras: device nodes that are
// plain files and a v4l2-ctl that answers for them stand in.

test.skip(!container, 'stands a v4l2-ctl and camera nodes in inside the run-web.sh container');

const STUB = '/usr/local/bin/v4l2-ctl';
const LOG = '/tmp/fpp-tests-v4l2.log';
const DEVS = [90, 91, 92, 93, 94, 95].map((n) => `/dev/video${n}`);
const clean = () => inPlayer('sh', '-c', `rm -f ${STUB} ${LOG} ${DEVS.join(' ')}`);

const all = (caps: string, extra = '') => `Driver Info:
	Driver name      : uvcvideo
${extra}	Capabilities     : 0x84a00001
		Video Capture
${caps}`;

const SCRIPT = `#!/bin/sh
echo "$*" >> ${LOG}
[ "$1" = "-d" ] || exit 2
case "$2:$3" in
/dev/video90:--all) cat <<'X'
${all('	Device Caps      : 0x04200001\n', '	Card type        : fpp-tests cam: HD  \n	Bus info         : usb-0000:01:00.0-1.2\n')}
User Controls
	power_line_frequency 0x00980918 (menu)   : min=0 max=2 default=2 value=1 (50 Hz)
Camera Controls
	auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3 (Aperture Priority Mode)
X
;;
/dev/video90:--list-formats-ext) cat <<'X'
ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'MJPG' (Motion-JPEG, compressed)
		Size: Discrete 1280x720
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.067s (15.000 fps)
			Interval: Discrete 0.033s (29.970 fps)
		Size: Discrete 640x480
			Interval: Discrete 0.017s (60.000 fps)
	[1]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 640x480
			Interval: Discrete 0.133s (7.500 fps)
			Interval: Discrete 2.500s (0.400 fps)
		Size: Stepwise 32x32 - 1920x1080 with step 2/2
X
;;
# The same camera's metadata node: capture bit off.
/dev/video91:--all) cat <<'X'
${all('	Device Caps      : 0x04a00000\n', '	Card type        : fpp-tests cam: HD\n')}
X
;;
# A decoder: capture and memory-to-memory.
/dev/video92:--all) cat <<'X'
${all('	Device Caps      : 0x04208001\n', '	Card type        : fpp-tests codec\n')}
X
;;
# An old driver: only the whole-device Capabilities line, no name.
/dev/video93:--all) cat <<'X'
${all('')}
X
;;
/dev/video93:--list-formats-ext) cat <<'X'
	[0]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 1280x720
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.067s (15.000 fps)
			Interval: Discrete 0.033s (29.970 fps)
		Size: Discrete 640x480
			Interval: Discrete 0.133s (7.500 fps)
			Interval: Discrete 2.500s (0.400 fps)
		Size: Stepwise 32x32 - 1920x1080 with step 2/2
X
;;
/dev/video95:--all) echo "Driver Info:" ;;
*) exit 1 ;;
esac
`;

test.beforeEach(() => {
  clean();
  putFile(STUB, SCRIPT);
  inPlayer('chmod', '755', STUB);
  inPlayer('sh', '-c', `touch ${DEVS.join(' ')}`);
});
test.afterEach(clean);

const mine = (list: any[]) => list.filter((d) => DEVS.includes(d.device));

test('the list is the capture nodes only, each with its name, bus, flicker setting and modes', async ({ request }) => {
  const r = await request.get('/api/pipewire/video/input-sources/v4l2-devices');
  expect(r.status()).toBe(200);
  expect(mine((await r.json()).devices)).toEqual([
    {
      device: '/dev/video90', name: 'fpp-tests cam: HD', busInfo: 'usb-0000:01:00.0-1.2',
      powerLineFrequency: 1, hasExposureControls: true,
      modes: expect.any(Array),
    },
    // No Device Caps line: the whole device's capabilities decide.  No Card
    // type: the node's path is its name.  One format: 29.97 is the 30 already
    // listed, a rate that rounds to 0 is dropped, a stepwise size is not a mode.
    { device: '/dev/video93', name: '/dev/video93', busInfo: '', powerLineFrequency: null, hasExposureControls: false, modes: [
      { format: 'YUYV', width: 1280, height: 720, framerates: [30, 15] },
      { format: 'YUYV', width: 640, height: 480, framerates: [8] },
    ] },
  ]);

  // Each node was asked about by its own path, and only the listed ones for modes.
  const log = inPlayer('cat', LOG).split('\n').filter((l) => /video9/.test(l));
  expect(log.filter((l) => l.endsWith('--all')).map((l) => l.split(' ')[1])).toEqual(DEVS);
  expect(log.filter((l) => l.endsWith('--list-formats-ext')).map((l) => l.split(' ')[1])).toEqual(['/dev/video90', '/dev/video93']);
});

test('a camera with two formats has every size of both in its modes', async ({ request }) => {
  test.fail(true, 'a new format line discards the size before it: the last size of each format but the final one is lost (FUTURE.md)');
  const r = await request.get('/api/pipewire/video/input-sources/v4l2-devices');
  expect(mine((await r.json()).devices)[0].modes).toEqual([
    { format: 'MJPG', width: 1280, height: 720, framerates: [30, 15] },
    { format: 'MJPG', width: 640, height: 480, framerates: [60] },
    { format: 'YUYV', width: 640, height: 480, framerates: [8] },
  ]);
});

test('with no v4l2-ctl answering, the list is empty, not an error', async ({ request }) => {
  putFile(STUB, '#!/bin/sh\nexit 1\n');
  inPlayer('chmod', '755', STUB);
  const r = await request.get('/api/pipewire/video/input-sources/v4l2-devices');
  expect(r.status()).toBe(200);
  expect(mine((await r.json()).devices)).toEqual([]);
});
