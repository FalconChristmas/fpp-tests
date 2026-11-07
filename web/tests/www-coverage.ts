import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from '@playwright/test';

// run-web.sh --www-coverage: which lines of the scripts the pages loaded ran,
// from Chromium's V8 coverage, for scripts/www-coverage-report.py. Most page
// loads run the same lines, so each script's set of lines is written once,
// named after its contents. Without that option this does nothing.
const dir = process.env.FPP_TESTS_WWW_COVERAGE_DIR;

type Entry = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>[number];

function sha(text: string) {
  return createHash('md5').update(text).digest('hex');
}

// The 0-based lines with code that ran. V8's ranges nest, each inner one
// overriding the one around it, so painting them outermost first leaves each
// character with its own count.
function linesRun(entry: Entry): number[] {
  const source = entry.source ?? '';
  const painted = new Uint8Array(source.length);
  const ranges = entry.functions.flatMap((f) => f.ranges);
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) painted.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
  const hit: number[] = [];
  let line = 0;
  let found = false;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 10) {
      if (found) hit.push(line);
      line++;
      found = false;
    } else if (painted[i] && c !== 32 && c !== 9 && c !== 13) {
      found = true;
    }
  }
  if (found) hit.push(line);
  return hit;
}

function record(entries: Entry[]) {
  for (const entry of entries) {
    if (!entry.source || !entry.url.startsWith('http')) continue;
    const url = new URL(entry.url);
    const sourceId = sha(url.pathname + '\0' + entry.source);
    const hit = linesRun(entry);
    const sourcePath = path.join(dir!, 'js-src', `${sourceId}.js`);
    if (!fs.existsSync(sourcePath)) fs.writeFileSync(sourcePath, entry.source);
    const hitPath = path.join(dir!, 'js', `${sha(sourceId + ':' + hit.join(','))}.json`);
    if (!fs.existsSync(hitPath)) {
      fs.writeFileSync(hitPath, JSON.stringify({ path: url.pathname, source: sourceId, hit }));
    }
  }
}

const running = new Map<Page, Promise<void>>();

// Before a page's first navigation, or its scripts are missed.
export async function startCoverage(page: Page) {
  if (!dir) return;
  if (!running.has(page)) {
    running.set(page, page.coverage.startJSCoverage({ resetOnNavigation: false }).catch(() => {}));
    // A test that closes a page takes that page's counts with it.
    const close = page.close.bind(page);
    page.close = async (options) => {
      await stopCoverage(page);
      return close(options);
    };
  }
  await running.get(page);
}

async function stopCoverage(page: Page) {
  const started = running.get(page);
  if (!started) return;
  running.delete(page);
  await started;
  if (page.isClosed()) return;
  record(await page.coverage.stopJSCoverage().catch(() => []));
}

export async function coveringContext(context: BrowserContext, use: (c: BrowserContext) => Promise<void>) {
  if (!dir) return use(context);
  const onPage = (page: Page) => void startCoverage(page);
  context.on('page', onPage);
  context.pages().forEach(onPage);
  await use(context);
  context.off('page', onPage);
  await Promise.all(context.pages().map(stopCoverage));
}
