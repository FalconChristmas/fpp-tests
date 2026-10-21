import { inPlayer } from './container';

// Plugins installed the way the Plugin Manager installs them, from git
// repositories made inside the run-web.sh container: a working copy under
// /tmp, pushed to a bare repository next to it that the player clones from
// (file:// URL, so nothing leaves the container).

export const MEDIA = '/home/fpp/media';
export const PLUGINS = `${MEDIA}/plugins`;
export const CONFIG = `${MEDIA}/config`;
export const HISTORY = `${CONFIG}/pluginHistory.jsonl`;

// A shell script run inside the player, as root; its stdout.
export function sh(script: string): string {
  return inPlayer('sh', '-c', script);
}

export function exists(path: string): boolean {
  return sh(`test -e '${path}' || test -L '${path}' && echo yes || echo no`).trim() === 'yes';
}

export function readFile(path: string): string {
  return sh(`cat '${path}' 2>/dev/null || true`);
}

// Whether $path contains the line $text (grep in the player: a log can be
// large).
export function fileHasText(path: string, text: string): boolean {
  const b64 = Buffer.from(text).toString('base64');
  return sh(`grep -qF -- "$(echo '${b64}' | base64 -d)" '${path}' && echo yes || echo no`).trim() === 'yes';
}

// Writes $content to $path in the player, through base64 so no quoting can
// bite; $mode e.g. '755'.
export function writeFile(path: string, content: string, mode?: string) {
  const b64 = Buffer.from(content).toString('base64');
  sh(`mkdir -p "$(dirname '${path}')" && echo '${b64}' | base64 -d > '${path}'${mode ? ` && chmod ${mode} '${path}'` : ''}`);
}

export class PluginRepo {
  readonly src: string;
  readonly url: string;
  readonly dir: string;

  constructor(readonly name: string) {
    this.src = `/tmp/fpp-tests-repo-${name}`;
    this.url = `file://${this.src}.git`;
    this.dir = `${PLUGINS}/${name}`;
  }

  // A fresh repository whose first commit is pluginInfo.json ($info on top of
  // name, repoName, srcURL and one versions[] entry for every FPP) plus $files.
  init(info: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
    sh(`set -e; rm -rf ${this.src} ${this.src}.git ${this.dir}
      git init -q --bare -b master ${this.src}.git
      git init -q -b master ${this.src} && cd ${this.src} && git remote add origin ${this.src}.git`);
    return this.commit('v1', { 'pluginInfo.json': JSON.stringify(this.info(info), null, 1), ...files });
  }

  info(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: this.name, repoName: this.name, srcURL: this.url, branch: 'master',
      versions: [{ minFPPVersion: '0', maxFPPVersion: '0', branch: 'master' }],
      ...extra,
    };
  }

  // Writes $files (a name ending in .sh, or under scripts/, is made
  // executable; a null content deletes the file), commits and pushes; the
  // new commit's sha.
  commit(msg: string, files: Record<string, string | null> = {}): string {
    for (const [f, content] of Object.entries(files)) {
      if (content === null) {
        sh(`rm -f '${this.src}/${f}'`);
      } else {
        writeFile(`${this.src}/${f}`, content, /\.sh$|^scripts\//.test(f) ? '755' : undefined);
      }
    }
    sh(`set -e; cd ${this.src}; git add -A; git -c user.name=t -c user.email=t@t commit -q --allow-empty -m '${msg}'; git push -q origin master`);
    return this.head();
  }

  setInfo(info: Record<string, unknown>, msg = 'info'): string {
    return this.commit(msg, { 'pluginInfo.json': JSON.stringify(this.info(info), null, 1) });
  }

  head(): string {
    return sh(`git -C ${this.src} rev-parse HEAD`).trim();
  }

  installedHead(): string {
    return sh(`git -c safe.directory='*' -C ${this.dir} rev-parse HEAD 2>/dev/null || true`).trim();
  }

  installed(): boolean {
    return exists(`${this.dir}/pluginInfo.json`);
  }

  remove() {
    sh(`rm -rf ${this.src} ${this.src}.git ${this.dir}`);
  }
}

// POST /api/plugin, non-streaming: the JSON reply.
export async function installPlugin(request: any, info: Record<string, unknown>): Promise<any> {
  const r = await request.post('/api/plugin', { data: JSON.stringify(info), timeout: 180_000 });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// POST /api/plugin?stream=true: the streamed text.
export async function installPluginStreamed(request: any, info: Record<string, unknown>): Promise<string> {
  const r = await request.post('/api/plugin?stream=true', { data: JSON.stringify(info), timeout: 180_000 });
  return r.text();
}

export async function uninstallPlugin(request: any, name: string, query = ''): Promise<any> {
  const r = await request.delete(`/api/plugin/${name}${query}`, { timeout: 180_000 });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// The plugin install history's entries for $plugin, oldest first.
export function historyOf(plugin: string): any[] {
  return readFile(HISTORY).split('\n').filter((l) => l.trim() !== '')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.plugin === plugin);
}

// What an install of a plugin from outside the plugin list leaves in
// settings (the "unknown plugin" health flag), cleared so it can't leak into
// other tests.
export function clearPluginSourceSettings() {
  sh(`sed -i '/^PluginUnknown/d; /^PluginUnverified/d; /^pluginReinstallNeededAfterOS/d' ${MEDIA}/settings`);
}

// Clones $repo into the plugins directory the way the Plugin Manager does,
// without the rest of an install (no scripts, no history).
export function clonePlugin(repo: PluginRepo) {
  sh(`git clone -q --single-branch --branch=master ${repo.url} ${repo.dir}`);
}

// A background update check, run to completion here (the same pass
// /api/plugin/updateStatus starts on its own when none has run).
export function runUpdateCheck() {
  sh('php /opt/fpp/scripts/plugin_update_check.php --force > /dev/null 2>&1 || true');
}

// The number of lines in $path now, to read only what is appended after.
export function lineCount(path: string): number {
  return parseInt(sh(`cat '${path}' 2>/dev/null | wc -l`).trim(), 10) || 0;
}

// The lines of $path after the first $from.
export function linesAfter(path: string, from: number): string[] {
  return sh(`tail -n +${from + 1} '${path}' 2>/dev/null | cut -c1-400 || true`).split('\n');
}

export const PLUGIN_LIST_URL = 'https://raw.githubusercontent.com/FalconChristmas/fpp-data/master/pluginList.json';

// Serves the Plugins page's plugin list (fetched by the browser from GitHub)
// from $list, and each entry's pluginInfo.json from $infos (by URL), so the
// page needs no network and shows exactly these.
export async function routePluginList(page: any, list: unknown[][] = [], infos: Record<string, unknown> = {}) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.route('https://raw.githubusercontent.com/**', (route: any) => {
    const url = route.request().url();
    if (url === PLUGIN_LIST_URL) {
      return route.fulfill({ json: { pluginList: list }, headers: cors });
    }
    if (url.endsWith('/fpp-data/master/pluginCategories.json')) {
      return route.fulfill({ json: { categories: [] }, headers: cors });
    }
    if (infos[url]) {
      return route.fulfill({ json: infos[url], headers: cors });
    }
    return route.fulfill({ status: 404, body: '', headers: cors });
  });
}
