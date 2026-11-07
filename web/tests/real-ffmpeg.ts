import { inPlayer } from './container';

// The real ffmpeg, which every player has but the web image keeps off the PATH
// (docker/web/Dockerfile): most specs are written for a player without it.  A
// spec that needs it links it in for its own tests and takes it out after;
// the suite runs one test at a time (playwright.config.ts), so no other spec
// sees it.

export const REAL_FFMPEG = '/opt/fpp-tests-ffmpeg/ffmpeg';
export const REAL_FFPROBE = '/opt/fpp-tests-ffmpeg/ffprobe';

const sh = (script: string) => inPlayer('sh', '-c', script);

// An image built before ffmpeg was added has none.
export function hasRealFfmpeg(): boolean {
  return sh(`test -x ${REAL_FFMPEG} && echo yes || echo no`).trim() === 'yes';
}

function link(real: string) {
  const at = `/usr/bin/${real.split('/').pop()}`;
  sh(`if [ -e ${at} ] && [ "$(readlink ${at})" != ${real} ]; then
        echo "${at} is already something else" >&2; exit 1; fi
      ln -sfn ${real} ${at}`);
}

function unlink(real: string) {
  const at = `/usr/bin/${real.split('/').pop()}`;
  sh(`if [ "$(readlink ${at})" = ${real} ]; then rm -f ${at}; fi`);
}

export const linkRealFfmpeg = () => link(REAL_FFMPEG);
export const unlinkRealFfmpeg = () => unlink(REAL_FFMPEG);
export const linkRealFfprobe = () => link(REAL_FFPROBE);
export const unlinkRealFfprobe = () => unlink(REAL_FFPROBE);

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
