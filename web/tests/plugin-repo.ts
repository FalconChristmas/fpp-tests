import { inPlayer } from './container';

// Fake plugins for the plugin install/update/uninstall specs: a git
// repository inside the player, cloned through a file:// URL, so nothing
// touches the network.  POST /api/plugin takes any URL filter_var() accepts,
// and a file:// one is cloned like any other (git allows the file transport
// outside submodules).

export const MEDIA = '/home/fpp/media';
export const PLUGINS = `${MEDIA}/plugins`;
export const CONFIG = `${MEDIA}/config`;

export function sh(script: string): string {
  return inPlayer('sh', '-c', script);
}

export function exists(path: string): boolean {
  return sh(`test -e '${path}' || test -L '${path}' && echo yes || echo no`).trim() === 'yes';
}

// A file's content, base64 through the shell so no quoting can bite.
type Files = Record<string, string | { content: string; mode: string }>;

function writeFiles(dir: string, files: Files): string {
  return Object.entries(files).map(([path, f]) => {
    const content = typeof f === 'string' ? f : f.content;
    const mode = typeof f === 'string' ? '' : `; chmod ${f.mode} '${dir}/${path}'`;
    const b64 = Buffer.from(content).toString('base64');
    return `mkdir -p "$(dirname '${dir}/${path}')" && echo '${b64}' | base64 -d > '${dir}/${path}'${mode}`;
  }).join('\n');
}

export function pluginInfo(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name, repoName: name,
    versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }],
    ...extra,
  }) + '\n';
}

// A plugin's upstream: a work tree and the bare repository it pushes to,
// which is what a plugin clone's origin is.
export class PluginRepo {
  readonly src: string;
  readonly bare: string;
  readonly url: string;

  constructor(readonly name: string) {
    this.src = `/tmp/fpp-tests-src-${name}`;
    this.bare = `${this.src}.git`;
    this.url = `file://${this.bare}`;
    sh(`set -e; rm -rf ${this.src} ${this.bare}
      git init -q --bare -b master ${this.bare}
      git init -q -b master ${this.src} && git -C ${this.src} remote add origin ${this.bare}`);
  }

  // Commits $files (on top of what is there) and pushes; the new commit id.
  commit(files: Files, message = 'commit'): string {
    return sh(`set -e; cd ${this.src}
      ${writeFiles(this.src, files)}
      git add -A && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m '${message}'
      git push -q origin master
      git rev-parse HEAD`).trim();
  }

  // The body POST /api/plugin takes for it.
  body(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { name: this.name, repoName: this.name, srcURL: this.url, branch: 'master', sha: '', ...extra };
  }

  remove() {
    sh(`rm -rf ${this.src} ${this.bare}`);
  }
}

// What a plugin operation leaves behind besides the plugin directory: the
// privacy record, the install history (from fcc5a58da on), the update-check
// state and the plugin source settings ("unknown" for a file:// clone).
// Saved before a test and put back after it, so the shared player is left as
// it was; a file that was not there is removed again.
const STATE_FILES = [
  `${CONFIG}/pluginPrivacyAccepted.json`,
  `${CONFIG}/pluginPrivacyAccepted.json.lock`,
  `${CONFIG}/pluginHistory.jsonl`,
  `${MEDIA}/cache/plugin_updates.json`,
  `${MEDIA}/cache/plugin_updates.json.lock`,
];
const SNAP = '/tmp/fpp-tests-plugin-state';

export function saveState() {
  sh(`set -e; rm -rf ${SNAP}; mkdir -p ${SNAP}
    ${STATE_FILES.map((f, i) => `if [ -e ${f} ]; then cp -p ${f} ${SNAP}/${i}; fi`).join('\n')}
    grep -E '^Plugin(UnknownEverInstalled|UnknownRepos|UnverifiedRepos) ' ${MEDIA}/settings > ${SNAP}/settings || true`);
}

export function restoreState(names: string[]) {
  const dirs = names.map((n) => `'${PLUGINS}/${n}'`).join(' ');
  sh(`rm -rf ${dirs}
    ${STATE_FILES.map((f, i) => `if [ -e ${SNAP}/${i} ]; then cp -p ${SNAP}/${i} ${f}; else rm -f ${f}; fi`).join('\n')}
    sed -i -E '/^Plugin(UnknownEverInstalled|UnknownRepos|UnverifiedRepos) /d' ${MEDIA}/settings
    cat ${SNAP}/settings >> ${MEDIA}/settings 2>/dev/null
    rm -rf ${SNAP}`);
}

// The plugin's install history entries (one JSON object per line).
export function history(name: string): Record<string, unknown>[] {
  const out = sh(`cat ${CONFIG}/pluginHistory.jsonl 2>/dev/null || true`);
  return out.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((e) => e && e.plugin === name);
}

export function privacyRecord(name: string): Record<string, unknown> | undefined {
  const out = sh(`cat ${CONFIG}/pluginPrivacyAccepted.json 2>/dev/null || true`).trim();
  if (!out) return undefined;
  const j = JSON.parse(out);
  return (j.plugins ?? j)[name];
}
