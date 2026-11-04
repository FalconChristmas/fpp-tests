import { test, expect } from './fixtures';
import { container } from './container';
import { usesPipewireConfig } from './pw-config-files';

// GET /api/pipewire/video/routing: the enabled video sources, with the node
// each one makes, and the enabled output groups with what feeds them.

test.skip(!container, "writes the run-web.sh container's PipeWire config");

const GROUPS = 'pipewire-video-groups.json', SOURCES = 'pipewire-video-input-sources.json';
const write = usesPipewireConfig(GROUPS, SOURCES);

test('it lists what is enabled, with each source named for its node', async ({ request }) => {
  write(SOURCES, { videoInputSources: [
    { id: 3, name: 'Yard Cam 1', type: 'v4l2', enabled: true },
    { id: 4, name: 'Off', type: 'v4l2', enabled: false },
  ] });
  write(GROUPS, { videoOutputGroups: [
    { id: 7, name: 'Wall', enabled: true, videoSource: 'fpp_video_src_3_yard_cam_1', streamSlots: [2], members: [{ type: 'hdmi' }, {}] },
    { id: 8, name: 'Off', enabled: false },
  ] });
  expect(await (await request.get('/api/pipewire/video/routing')).json()).toEqual({
    videoSources: [{ id: 3, name: 'Yard Cam 1', type: 'v4l2', pipeWireNodeName: 'fpp_video_src_3_yard_cam_1' }],
    videoGroups: [{ id: 7, name: 'Wall', videoSource: 'fpp_video_src_3_yard_cam_1', streamSlots: [2], memberTypes: ['hdmi'] }],
  });
});
