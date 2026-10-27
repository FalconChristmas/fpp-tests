import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';
import { nullSink, startPipeWire, stopPipeWire } from './pw-live';

// The Troubleshooting page: a tab per command group that applies to this
// platform, each with its commands' hotlinks and outputs, which
// troubleshootingHelper.php runs by key when the tab is opened.

test.skip(!container, 'runs the troubleshooting commands inside the run-web.sh container');

type Groups = Record<string, { grpDisplayTitle: string; platforms: string[]; level?: number;
  commands: Record<string, { title: string; platforms: string[]; level?: number }> }>;

async function groups(request: APIRequestContext): Promise<Groups> {
  return (await (await request.get('/troubleshoot-commands.json')).json()).CommandGroups;
}

async function platform(request: APIRequestContext): Promise<string> {
  return (await (await request.get('/api/system/info')).json()).Platform;
}

const applies = (platforms: string[], p: string) => platforms.includes('all') || platforms.includes(p);

async function openTab(page: Page, grp: string) {
  await page.locator(`#pills-${grp}-tab`).click();
  await expect(page.locator(`#pills-${grp}`)).toBeVisible();
}

async function run(request: APIRequestContext, key: string): Promise<string> {
  return (await request.get(`/troubleshootingHelper.php?key=${encodeURIComponent(key)}`, { timeout: 60_000 })).text();
}

test('a group that does not apply here leaves the groups after it intact', async ({ page, request }) => {
  // Regression: 693b0a64f ("Troubleshooting page doesn't display correctly
  // after section that doesn't apply", #2577).  A group for another platform
  // still had its command list and three closing </div>s written out, which
  // closed the tab container early: every tab after it lost its place.
  const all = await groups(request);
  const p = await platform(request);
  const shown = Object.keys(all).filter((g) => applies(all[g].platforms, p) && (all[g].level ?? 0) === 0);
  const skipped = Object.keys(all).filter((g) => !applies(all[g].platforms, p));
  // The control: some group does not apply here, and one that does follows it.
  const after = skipped.map((g) => Object.keys(all)[Object.keys(all).indexOf(g) + 1]).filter((g) => g && shown.includes(g));
  expect(skipped.length, `platform ${p}`).toBeGreaterThan(0);
  expect(after.length).toBeGreaterThan(0);

  await page.goto('/troubleshooting.php');
  for (const g of skipped) {
    await expect(page.locator(`#pills-${g}, #troubleshooting-results-${g}`), g).toHaveCount(0);
  }
  // Every tab that is shown sits in the tab container, its commands in it.
  const parents = await page.locator('.tab-pane').evaluateAll((ps) => ps.map((e) => [e.id, e.parentElement?.id]));
  expect(parents.filter(([, parent]) => parent !== 'pills-tabContent'), 'tabs outside the tab container').toEqual([]);
  for (const g of after) {
    await openTab(page, g);
    const keys = Object.keys(all[g].commands).filter((k) => applies(all[g].commands[k].platforms, p) && (all[g].commands[k].level ?? 0) === 0);
    for (const k of keys) {
      await expect(page.locator(`#pills-${g} #command_${k}`), `${g}: ${k}`).toBeVisible();
      await expect(page.locator(`#troubleshooting-hot-links-${g} a[href="#header_${k}"]`)).toHaveText(all[g].commands[k].title);
    }
  }
});

test('the USB tab lists the USB devices', async ({ page, request }) => {
  // Feature: 2838769b8 ("additional troubleshooting commands"): USB Device
  // List (lsusb).  (Its "FPP Image 32/64-bit" entry was removed again by
  // 4a8d4e096.)  The container has no lsusb: a stand-in prints one device.
  const LSUSB = '/usr/bin/lsusb';
  const had = inPlayer('sh', '-c', `test -e ${LSUSB} && echo y || echo n`).trim() === 'y';
  if (!had) {
    putFile(LSUSB, '#!/bin/sh\necho "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub"\n');
    inPlayer('chmod', '755', LSUSB);
  }
  try {
    await page.goto('/troubleshooting.php');
    await openTab(page, 'USB');
    await expect(page.locator('#troubleshooting-hot-links-USB a[href="#header_USBDeviceList"]')).toHaveText('USB Device List');
    await expect(page.locator('#pills-USB #command_USBDeviceList')).toContainText(had ? 'Bus ' : 'Linux Foundation 2.0 root hub', { timeout: 30_000 });
  } finally {
    if (!had) inPlayer('rm', '-f', LSUSB);
  }
});

test('the Media Backend tab reports on a running PipeWire and GStreamer', async ({ page, request }) => {
  // Feature: b3d7a4ad7 ("add media backend troubleshooting commands").  A real
  // PipeWire of the test's own runs on FPP's runtime directory, with a null
  // sink standing in for a card; what the commands print comes from it.  The
  // two systemd ones (service status, journal) have no systemd to ask in a
  // container and are not run here.
  test.setTimeout(120_000);
  const SINK = 'fpp-tests-troubleshoot-sink';
  startPipeWire({ objects: [nullSink(SINK)] });
  try {
    const all = await groups(request);
    expect(all.Media?.grpDisplayTitle).toBe('Media Backend');
    await page.goto('/troubleshooting.php');
    await openTab(page, 'Media');
    for (const k of Object.keys(all.Media.commands)) {
      await expect(page.locator(`#troubleshooting-hot-links-Media a[href="#header_${k}"]`)).toHaveText(all.Media.commands[k].title);
    }
    const want: Record<string, string> = {
      WirePlumberStatus: SINK,
      PipeWireSinks: `Name: ${SINK}`,
      PipeWireNodes: SINK,
      GStreamerVersion: 'GStreamer',
      GStreamerPipeWireSink: 'pipewiresink',
    };
    for (const [k, text] of Object.entries(want)) {
      await expect(page.locator(`#pills-Media #command_${k}`), k).toContainText(text, { timeout: 30_000 });
    }
    // These answer too, if with nothing to report.
    for (const k of ['PipeWireCards', 'FPPMediaSettings']) {
      expect(await run(request, k), k).not.toMatch(/Failed to return valid result|Unknown Command/);
    }
  } finally {
    stopPipeWire();
  }
});

test('the Media Files tab runs its report once per page load', async ({ page, request }) => {
  // Feature: c42fd987d (Media Files tab, "runOnce").  The report probes every
  // media file, so it runs the first time its tab is opened and not on every
  // later click on the tab.  The container has no ffprobe: a stand-in
  // answers for WAV files only, as in scenarios/test_media_report.py, which
  // checks what the report says about them.
  test.setTimeout(120_000);
  const FFPROBE = '/usr/bin/ffprobe';
  const WAV = '/home/fpp/media/music/fpp-tests-media-report.wav';
  const had = inPlayer('sh', '-c', `test -e ${FFPROBE} && echo y || echo n`).trim() === 'y';
  if (!had) {
    putFile(FFPROBE, [
      '#!/usr/bin/python3 -I',
      'import json, os, sys, wave',
      'path = sys.argv[-1]',
      'try:',
      '    w = wave.open(path, "rb")',
      'except Exception:',
      '    sys.stderr.write("Invalid data found when processing input\\n"); sys.exit(1)',
      'rate, ch, width, frames = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()',
      'dur = "%.6f" % (frames / rate)',
      'print(json.dumps({"streams": [{"index": 0, "codec_type": "audio", "codec_name": "pcm_s16le",',
      '    "sample_rate": str(rate), "channels": ch, "bits_per_sample": 8 * width, "duration": dur}],',
      '    "format": {"format_name": "wav", "duration": dur, "size": str(os.path.getsize(path))}}))',
      '',
    ].join('\n'));
    inPlayer('chmod', '755', FFPROBE);
  }
  inPlayer('python3', '-c', `import wave; w = wave.open("${WAV}", "wb"); w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100); w.writeframes(bytes(17640))`);
  try {
    const all = await groups(request);
    expect(all.MediaFiles?.grpDisplayTitle).toBe('Media Files');
    const runs: string[] = [];
    page.on('request', (r) => { if (r.url().includes('troubleshootingHelper.php?key=MediaFileReport')) runs.push(r.url()); });
    await page.goto('/troubleshooting.php');
    expect(runs, 'the report ran before its tab was opened').toEqual([]);
    await openTab(page, 'MediaFiles');
    const out = page.locator('#pills-MediaFiles #command_MediaFileReport');
    await expect(out).toContainText('FPP Media Report', { timeout: 60_000 });
    await expect(out).toContainText('fpp-tests-media-report.wav');
    const other = Object.keys(all).find((g) => g !== 'MediaFiles' && (all[g].level ?? 0) === 0 &&
      (all[g].platforms.includes('all')));
    await openTab(page, other!);
    await openTab(page, 'MediaFiles');
    await page.waitForTimeout(2_000);
    expect(runs.length, 'the report ran again when its tab was opened a second time').toBe(1);
    await expect(out).toContainText('fpp-tests-media-report.wav');
  } finally {
    inPlayer('rm', '-f', WAV);
    if (!had) inPlayer('rm', '-f', FFPROBE);
  }
});
