import { test, expect } from './fixtures';
import { container } from './container';

// The Troubleshooting page's Media Health Checks tab: nine commands, each
// one section of scripts/pipewire_diagnostics.sh, run by troubleshootingHelper.php
// as troubleshoot-commands.json declares them.  The container has no
// PipeWire, WirePlumber or sound card, so the checks mostly fail: what is
// checked is that every command reaches its section of the script and the
// script gets as far as its verdict summary, which is the page's receiving end.

test.skip(!container, 'runs the diagnostics script inside the run-web.sh container');

const SECTIONS: Record<string, string> = {
  PWCheckServices: 'PipeWire Service & Runtime Health',
  PWCheckConfig: 'PipeWire Configuration Integrity',
  PWCheckGraph: 'PipeWire Graph vs Configuration',
  PWCheckAlsa: 'ALSA Hardware & Device Contention',
  PWCheckGStreamer: 'GStreamer Elements & Plugins',
  PWCheckNetwork: 'Network Audio & Video Outputs',
  PWCheckVideo: 'Video Input & Output',
  PWCheckPerformance: 'Latency, Clocking & Dropouts',
  PWCheckSmoke: 'End-to-end Pipeline Test',
};

test('the Media Health Checks tab runs each section of the PipeWire diagnostics', async ({ page }) => {
  // Feature: ad049b27d ("Add Media Health Checks for PipeWire and GStreamer").
  test.setTimeout(240_000);
  await page.goto('/troubleshooting.php');
  await page.locator('#pills-MediaChecks-tab').click();
  await expect(page.locator('#pills-MediaChecks')).toBeVisible();
  for (const [key, title] of Object.entries(SECTIONS)) {
    await expect(page.locator(`#troubleshooting-hot-links-MediaChecks a[href="#header_${key}"]`), key).toBeVisible();
    const out = page.locator(`#pills-MediaChecks #command_${key}`);
    await expect(out, `${key} never reached its section`).toContainText(`=== ${title} ===`, { timeout: 120_000 });
    await expect(out, `${key} did not finish`).toContainText(/Result: \d+ passed, \d+ warnings, \d+ failures/, { timeout: 120_000 });
    expect(await out.innerText(), `${key} ran into the script's usage message`).not.toContain('Usage:');
  }
});
