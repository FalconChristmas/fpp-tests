import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// When a File Copy's stream is cut off (a proxy timeout, a dropped
// connection) the dialog falls back to polling the copy's progress feed,
// api/file/Logs/fpp_backup_filecopy_<id>.log, once a second, and takes the
// feed's disappearance (copystorage.php removes it when the run ends) as the
// copy being finished.

test('the fallback poll of a File Copy treats a feed that is gone as the copy finished', async ({ page }) => {
  // Regression: ecaa90090 ("File Copy Backup Enhancements": "Save output of
  // copy process to file & ability to read that file in cases where the
  // connection is terminated").  The poll took the API's "File does not
  // exist." answer to the missing feed as the end of the copy.  The file API
  // now answers a missing file with a 404 and its full path, which the poll
  // did not handle, so a dialog that fell back to polling never finished.
  await page.goto('/backup.php');
  await page.waitForFunction(() => typeof (window as any).fppFileCopy !== 'undefined');
  await page.evaluate(() => {
    const f = (window as any).fppFileCopy;
    f.newFeedId();
    f.fppTestsDone = false;
    f.copyDone = () => { f.fppTestsDone = true; };
    f.copyTimeoutError();
  });
  await expect.poll(() => page.evaluate(() => (window as any).fppFileCopy.fppTestsDone), { timeout: 10_000 }).toBe(true);
});

test('the fallback poll of a File Copy finishes when the feed says the drive was unmounted', async ({ page }) => {
  // The control for the test above: a feed that exists and ends with the
  // copy script's "unmounted from" line finishes the dialog, so the harness
  // can see a finish.
  test.skip(!container, 'writes a progress feed inside the run-web.sh container');
  await page.goto('/backup.php');
  await page.waitForFunction(() => typeof (window as any).fppFileCopy !== 'undefined');
  const id = await page.evaluate(() => {
    const f = (window as any).fppFileCopy;
    f.fppTestsDone = false;
    f.copyDone = () => { f.fppTestsDone = true; };
    return f.newFeedId();
  });
  const feed = `/home/fpp/media/logs/fpp_backup_filecopy_${id}.log`;
  inPlayer('sh', '-c', `echo "copying" > ${feed}`);
  try {
    await page.evaluate(() => (window as any).fppFileCopy.copyTimeoutError());
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => (window as any).fppFileCopy.fppTestsDone), 'finished while the feed was still running').toBe(false);
    inPlayer('sh', '-c', `echo "/dev/sdz1 unmounted from /mnt/x" >> ${feed}`);
    await expect.poll(() => page.evaluate(() => (window as any).fppFileCopy.fppTestsDone), { timeout: 10_000 }).toBe(true);
  } finally {
    inPlayer('rm', '-f', feed);
  }
});
