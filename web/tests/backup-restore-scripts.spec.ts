import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Restoring a backup restores its scripts as files and runs nothing out of
// them, and installScript, which runs as root, writes only into the scripts
// folder.  Before fpp 162dd4dd8 ("fix(security): don't run a restored
// backup's script install actions; confine installScript"):
// - a restore ran every restored script's "# InstallAction:" lines as root
//   (backup.php RestoreScripts() -> sudo scripts/restoreScript), and a backup
//   is a file anyone can hand you;
// - installScript built the file it writes from its arguments unchecked, so a
//   "../" wrote outside the scripts folder, and ran the install actions of
//   whatever arrived there.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const SCRIPT = 'fpp-tests-ia.sh';
const MARKER = `${MEDIA}/tmp/fpp-tests-install-action-ran`;

function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e '${path}' && echo yes || echo no`).trim() === 'yes';
}

test("a restored script's InstallAction lines are not run", async ({ request }) => {
  inPlayer('sh', '-c', `printf '#!/bin/sh\\n# InstallAction: touch ${MARKER}\\necho fpp-tests\\n' > ${MEDIA}/scripts/${SCRIPT}`);
  try {
    // A real backup of the scripts area, as the Backup page downloads it.
    const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'show_setup' } });
    expect(dl.ok()).toBe(true);
    const backup = await dl.body();
    expect(backup.toString(), 'the backup does not carry the script').toContain(SCRIPT);
    inPlayer('rm', '-f', `${MEDIA}/scripts/${SCRIPT}`, MARKER);

    const r = await request.post('/backup.php', {
      multipart: {
        btnRestoreConfig: '1',
        restorearea: 'show_setup',
        conffile: { name: 'fpp-tests-scripts.json', mimeType: 'application/json', buffer: backup },
      },
    });
    expect(r.ok()).toBe(true);
    // The control: the script itself came back.
    expect(exists(`${MEDIA}/scripts/${SCRIPT}`), 'the restore did not restore the script').toBe(true);
    expect(exists(MARKER), "the restore ran the script's InstallAction").toBe(false);
  } finally {
    // The restore also asks for a restart and boot actions, as it should.
    inPlayer('sh', '-c', `rm -f ${MEDIA}/scripts/${SCRIPT} ${MARKER}; sed -i '/^BootActions\\s*=/d; s/^restartFlag\\s*=.*/restartFlag = "0"/' ${MEDIA}/settings`);
  }
});

test('installScript refuses a name that leaves the scripts folder', async () => {
  // The container has no route to GitHub: a stand-in answers the download
  // with a script that declares an install action. scripts/common puts
  // /bin:/usr/bin first in PATH, so the image's own wget is moved aside for
  // the test.
  const target = `${MEDIA}/config/fpp-tests-installscript`;
  const bin = '/tmp/fpp-tests-wget';
  const realWget = '/usr/bin/wget';
  inPlayer('sh', '-c', `[ ! -e ${realWget} ] || mv ${realWget} ${realWget}.fpp-tests`);
  inPlayer('sh', '-c', `mkdir -p ${bin} && cat > ${bin}/wget <<'STUB'
#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -O) out="$2"; shift 2 ;; *) shift ;; esac; done
printf '# InstallAction: touch ${MARKER}\\n' > "$out"
STUB
chmod 755 ${bin}/wget`);
  try {
    const out = inPlayer('sh', '-c', `PATH=${bin}:$PATH /opt/fpp/scripts/installScript fpp-tests ../config/fpp-tests-installscript >/dev/null 2>&1; echo rc=$?`).trim();
    expect(exists(target), `installScript wrote ${target} (${out})`).toBe(false);
    expect(exists(MARKER), 'installScript ran the install action of what it wrote').toBe(false);
    expect(out).not.toBe('rc=0');
    // Control: the stand-in does what installScript expects of wget.
    const ok = inPlayer('sh', '-c', `PATH=${bin}:$PATH /opt/fpp/scripts/installScript fpp-tests ${SCRIPT} >/dev/null 2>&1; echo rc=$?`).trim();
    expect(ok).toBe('rc=0');
    expect(exists(`${MEDIA}/scripts/${SCRIPT}`)).toBe(true);
  } finally {
    inPlayer('rm', '-rf', target, MARKER, bin, `${MEDIA}/scripts/${SCRIPT}`);
    inPlayer('sh', '-c', `[ ! -e ${realWget}.fpp-tests ] || mv ${realWget}.fpp-tests ${realWget}`);
  }
});
