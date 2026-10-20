import { inPlayer } from './container';

// Helpers for the PipeWire config injection specs: a name built to break out
// of the SPA-JSON it is written into, and what to look for afterwards.

const CONFIG = '/home/fpp/media/config';
export const EVIL = 'fpp-tests"\n}\ncontext.exec = [ { path = "/bin/touch" args = "/tmp/fpp-tests-pwned" } ]\n#';

// What a name must not have done to the config it was written into.
export function injected(conf: string): string[] {
  const bad: string[] = [];
  for (const line of conf.split('\n')) {
    if (/^\s*context\.exec\b/.test(line)) bad.push(line);
    if (/node\.description\s*=/.test(line) && (line.match(/"/g) || []).length !== 2) bad.push(line);
  }
  return bad;
}

export function readConf(name: string): string {
  return inPlayer('sh', '-c', `cat ${CONFIG}/${name} 2>/dev/null || true`);
}

// An enabled output group for an input group to route to, written as saved
// config: applying output groups needs a sound card.
export function seedOutputGroup() {
  inPlayer('sh', '-c', `echo '{"groups":[{"id":1,"name":"fpp-tests out","enabled":true,"channels":2,"members":[]}]}' > ${CONFIG}/pipewire-audio-groups.json`);
}

export function cleanup() {
  inPlayer('sh', '-c', `cd ${CONFIG} && rm -f pipewire-audio-groups.json pipewire-input-groups.json pipewire-input-groups.conf ` +
    `pipewire-vban-instances.json pipewire-vban.conf pipewire-opus-rtp-instances.json; ` +
    `rm -f /etc/pipewire/pipewire.conf.d/9*-fpp-*.conf /tmp/fpp-tests-pwned`);
}


// An Apply restarts fppd in place a moment after it answers.  Wait for that
// restart to finish, so the next test (or the end-of-run check of fppd) does
// not meet fppd halfway through it.
export async function settleAfterApply(request: { get(url: string): Promise<{ ok(): boolean; json(): Promise<any> }> }) {
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 3000));
  let steady = 0;
  while (Date.now() - started < 30_000 && steady < 3) {
    try {
      const r = await request.get('/api/fppd/status');
      const st = r.ok() ? await r.json() : {};
      steady = st.fppd === 'running' || 'status_name' in st ? steady + 1 : 0;
    } catch {
      steady = 0;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
