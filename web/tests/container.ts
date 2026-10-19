import { execFileSync } from 'child_process';

// The container run-web.sh serves the UI from, for the tests that have to act
// from inside the player (a request from its own loopback) or put another
// host next to it.  Unset when the suite runs against any other player, and
// those tests skip.
export const container = process.env.FPP_TESTS_WEB_CONTAINER || '';

export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A command run inside the player, as root; its stdout.
export function inPlayer(...cmd: string[]): string {
  return docker('exec', container, ...cmd);
}

// The player's own non-loopback IPv4 address and its Docker network.
export function playerAddress(): { ip: string; network: string } {
  const out = docker('inspect', '-f', '{{range $n, $v := .NetworkSettings.Networks}}{{$n}} {{$v.IPAddress}}{{"\\n"}}{{end}}', container);
  const [network, ip] = out.trim().split('\n')[0].split(' ');
  return { ip, network };
}
