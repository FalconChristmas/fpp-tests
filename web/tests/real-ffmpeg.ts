import { inPlayer } from './container';

// The real ffmpeg, which every player has but the web image keeps off the PATH
// (docker/web/Dockerfile): most specs are written for a player without it.  A
// spec that needs it links it in for its own tests and takes it out after;
// the suite runs one test at a time (playwright.config.ts), so no other spec
// sees it.

export const REAL_FFMPEG = '/opt/fpp-tests-ffmpeg/ffmpeg';
const LINK = '/usr/bin/ffmpeg';

const sh = (script: string) => inPlayer('sh', '-c', script);

// An image built before ffmpeg was added has none.
export function hasRealFfmpeg(): boolean {
  return sh(`test -x ${REAL_FFMPEG} && echo yes || echo no`).trim() === 'yes';
}

export function linkRealFfmpeg() {
  sh(`if [ -e ${LINK} ] && [ "$(readlink ${LINK})" != ${REAL_FFMPEG} ]; then
        echo "${LINK} is already something else" >&2; exit 1; fi
      ln -sfn ${REAL_FFMPEG} ${LINK}`);
}

export function unlinkRealFfmpeg() {
  sh(`if [ "$(readlink ${LINK})" = ${REAL_FFMPEG} ]; then rm -f ${LINK}; fi`);
}

// Runs the real ffmpeg in the player (to make test media), quietly.
export function ffmpeg(args: string) {
  sh(`${REAL_FFMPEG} -v error -y ${args}`);
}

// A stereo 997 Hz sine of $seconds at $dbfs (its peak, so very nearly its
// true peak), with an optional full-scale click every second: a quiet song
// whose peaks are loud.  997 Hz is where BS.1770's weighting is flat, so the
// tone measures close to its level in LUFS.
export function tone(path: string, dbfs: number, seconds: number, opts: { clicks?: boolean } = {}) {
  const a = Math.pow(10, dbfs / 20).toFixed(6);
  const ch = `${a}*sin(2*PI*997*t)${opts.clicks ? '+if(lt(mod(t\\,1)\\,0.0005)\\,0.9\\,0)' : ''}`;
  ffmpeg(`-f lavfi -i "aevalsrc=${ch}|${ch}:s=48000:d=${seconds}" '${path}'`);
}
