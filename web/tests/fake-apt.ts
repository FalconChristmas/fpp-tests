import fs from 'fs';
import path from 'path';
import { sh, readFile, writeFile } from './plugin-backfill';

// fake-apt.py as apt-get, apt-cache, apt-mark and dpkg-query in the player,
// for tests of what FPP does with a plugin's system packages: fake packages
// install, fail and get removed without the real apt touching the container.

const DIR = '/tmp/fpp-tests-apt';
const TOOLS = ['apt-get', 'apt-cache', 'apt-mark', 'dpkg-query'];

export type FakePackage = { version?: string; auto?: boolean; hold?: boolean };
export type FakeAptState = {
  installed?: Record<string, FakePackage>;
  available?: string[];
  listFails?: boolean;
};

export function installFakeApt(state: FakeAptState) {
  writeFile(`${DIR}/stub.py`, fs.readFileSync(path.join(__dirname, 'fake-apt.py'), 'utf8'));
  writeFile(`${DIR}/state.json`, JSON.stringify({ installed: {}, available: [], ...state }));
  sh(`: > ${DIR}/calls.log; chmod 666 ${DIR}/calls.log ${DIR}/state.json`);
  for (const t of TOOLS) {
    writeFile(`/usr/local/bin/${t}`, `#!/bin/sh\nexec python3 ${DIR}/stub.py ${t} "$@"\n`, '755');
  }
}

export function removeFakeApt() {
  sh(`rm -f ${TOOLS.map((t) => `/usr/local/bin/${t}`).join(' ')}; rm -rf ${DIR}`);
}

export function fakeAptState(): Required<FakeAptState> {
  return JSON.parse(readFile(`${DIR}/state.json`));
}

// Every call made, as argv arrays (tool first).
export function fakeAptCalls(): string[][] {
  return readFile(`${DIR}/calls.log`).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
}

// The apt-get calls that would have changed the system: not -s, not update.
export function aptChanges(): string[] {
  return fakeAptCalls().filter((c) => c[0] === 'apt-get' && !c.includes('-s') && !c.includes('update'))
    .map((c) => c.filter((a, i) => a !== '-o' && c[i - 1] !== '-o').join(' '));
}
