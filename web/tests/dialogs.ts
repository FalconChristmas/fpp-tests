import type { Page } from '@playwright/test';

// Bootstrap's Modal.hide() does nothing while a dialog is still fading in,
// and a dialog's own controls can be clicked before shown.bs.modal fires, so
// a test that acts on a dialog right after opening it can be dropped
// (c60b48d).  These wait for the dialog itself, not for time.

// Runs open() and waits for the next dialog it opens to be shown.  The
// listener is in place before open() runs, so a fast dialog is not missed.
export async function whenModalShown(page: Page, open: () => Promise<unknown>) {
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await open();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
}

// Waits until the dialog with this id is neither fading in nor out (or has no
// Bootstrap instance at all).
export async function modalSettled(page: Page, id: string) {
  await page.waitForFunction((i) => {
    const el = document.getElementById(i);
    const m = el && (window as any).bootstrap.Modal.getInstance(el);
    return !m || !m._isTransitioning;
  }, id);
}
