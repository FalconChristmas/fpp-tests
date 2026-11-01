import { test, expect } from './fixtures';
import { container } from './container';
import { cleanupAsound, callApi, fakeDrm } from './fake-asound';

// The Video Output choices (GetOptions_VideoOutput): the display connectors
// of the display card, from /sys/class/drm -- here a Pi's HDMI port, a DSI
// touchscreen and the composite TV-out (fake-asound.ts, which runs the
// controller function under PHP's CLI with /sys/class/drm read from a tree
// written for the test; the container has no display card).

test.skip(!container, 'stands in a display card inside the run-web.sh container');

test.afterEach(() => cleanupAsound());

test('the Video Output choices include a composite output, with the HDMI and DSI ones', () => {
  // Regression: 94a028f09.  Only HDMI and DSI connectors were listed, so a
  // Pi's composite TV-out (Composite-1) could not be chosen as the video
  // output.  fppd taking the choice for a display is
  // scenarios/test_media_video_output.py.
  fakeDrm(['card0-HDMI-A-1', 'card0-DSI-1', 'card0-Composite-1', 'card0-Writeback-1']);
  const options = callApi('GetOptions_VideoOutput', false);
  expect(Object.keys(options)).toEqual(expect.arrayContaining(['HDMI-A-1', 'DSI-1', 'Composite-1', 'Disabled']));
  // The control: a connector that is not a display output is not offered.
  expect(Object.keys(options)).not.toContain('Writeback-1');
});
