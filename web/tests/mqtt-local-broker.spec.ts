import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';
import { putFile } from './settings-file';

// The local MQTT broker (Service_MQTT_localbroker): saving it, or the MQTT
// password while it is on, writes mosquitto's password file and a conf.d
// snippet and restarts mosquitto.  The player has no systemd, so systemctl is
// a stand-in that logs its calls; the receiving end is the real mosquitto,
// started here as its service would be (as root, dropping to the mosquitto
// user), from the files the PHP wrote, and asked by the real mosquitto_pub
// whether it takes a password.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const PASSWD = '/etc/mosquitto/passwd';
const SNIPPET = '/etc/mosquitto/conf.d/fpp_local_broker.conf';
const SYSTEMCTL = '/usr/local/bin/systemctl';
const MARK = 'fpp-tests-systemctl';
const CONF = '/tmp/fpp-tests-mosquitto.conf';
const LOG = '/tmp/fpp-tests-mosquitto.log';
const PWNED = '/tmp/fpp-tests-mqtt-pwned';

function sh(script: string): string {
  return inPlayer('sh', '-c', script);
}

function cleanup() {
  sh(`pkill -x mosquitto; for i in $(seq 50); do pgrep -x mosquitto > /dev/null || break; sleep 0.1; done; ` +
    `grep -q ${MARK} ${SYSTEMCTL} 2>/dev/null && rm -f ${SYSTEMCTL}; ` +
    `rm -f ${PASSWD} ${SNIPPET} ${CONF} ${LOG} ${PWNED} /tmp/fpp-tests-systemctl.log; true`);
}

test.beforeEach(() => {
  cleanup();
  const real = sh(`test -e ${SYSTEMCTL} && ! grep -q ${MARK} ${SYSTEMCTL} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${SYSTEMCTL} is a real program in the player; not replacing it`);
  putFile(SYSTEMCTL, `#!/bin/sh\n# ${MARK}\necho "$*" >> /tmp/fpp-tests-systemctl.log\n` +
    `[ "$1" = is-enabled ] && echo disabled\nexit 0\n`);
  sh(`chmod 755 ${SYSTEMCTL}`);
});

test.afterEach(() => cleanup());

// The broker from the conf.d snippet the PHP wrote; its log, if it didn't come up.
function startBroker(): string {
  putFile(CONF, `log_dest file ${LOG}\ninclude_dir /etc/mosquitto/conf.d\n`);
  sh(`pkill -x mosquitto; touch ${LOG} && chmod 666 ${LOG} && mosquitto -c ${CONF} -d; ` +
    'for i in $(seq 50); do ss -ltn | grep -q ":1883 " && break; sleep 0.1; done');
  return sh(`cat ${LOG}`);
}

function brokerTakes(password: string): boolean {
  try {
    execFileSync('docker', ['exec', container, 'mosquitto_pub', '-h', '127.0.0.1', '-p', '1883',
      '-u', 'fpp', '-P', password, '-t', 'fpp-tests', '-m', 'x'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function restarts(): number {
  return sh('cat /tmp/fpp-tests-systemctl.log 2>/dev/null || true').split('\n').filter((l) => l === 'restart mosquitto').length;
}

async function put(request: APIRequestContext, name: string, value: string) {
  const r = await request.put(`/api/settings/${name}`, { data: value });
  expect(r.ok(), await r.text()).toBe(true);
}

test('turning the local broker on gives it the MQTT password, not the OS password', async ({ request }) => {
  // Regression: f3aaec63f.  SetupLocalMQTTBroker() made the broker's password
  // file from osPassword.
  await keepingSettings(async () => {
    setSettingInFile('Service_MQTT_localbroker', '0');
    setSettingInFile('MQTTPassword', 'fpp-tests-mqtt-1');
    setSettingInFile('osPassword', 'fpp-tests-os-1');
    await put(request, 'Service_MQTT_localbroker', '1');
    expect(restarts(), 'mosquitto was not restarted').toBe(1);
    const log = startBroker();
    expect(brokerTakes('fpp-tests-mqtt-1'), `the broker refused the MQTT password\n${log}`).toBe(true);
    expect(brokerTakes('fpp-tests-os-1')).toBe(false);
  });
});

test("the broker's password file is one the broker, as the mosquitto user, can read", async ({ request }) => {
  // Regression: 69534f68b.  mosquitto_passwd, run as root, left the file
  // root's and 0600; mosquitto drops to its own user and couldn't open it,
  // so the broker didn't start.  Both passwords are the same here, as the
  // fix's parent read osPassword (see f3aaec63f above).
  await keepingSettings(async () => {
    setSettingInFile('Service_MQTT_localbroker', '0');
    setSettingInFile('MQTTPassword', 'fpp-tests-mqtt-2');
    setSettingInFile('osPassword', 'fpp-tests-mqtt-2');
    await put(request, 'Service_MQTT_localbroker', '1');
    expect(sh(`stat -c '%U:%G %a' ${PASSWD}`).trim()).toBe('mosquitto:mosquitto 640');
    const log = startBroker();
    expect(log).not.toContain('Unable to open pwfile');
    expect(brokerTakes('fpp-tests-mqtt-2'), `the broker didn't take the password\n${log}`).toBe(true);
  });
});

test('an MQTT password with shell characters runs nothing and is the one the broker takes', async ({ request }) => {
  // Regression: 97c553671.  Saving MQTTPassword provisioned the broker with
  // the value from before the save (the request's settings were read before
  // it), so the new password was refused; and the password went into the
  // root mosquitto_passwd command line unquoted (the next test).
  const password = `fpp-tests;touch ${PWNED};x $(touch ${PWNED})`;
  await keepingSettings(async () => {
    setSettingInFile('Service_MQTT_localbroker', '1');
    setSettingInFile('MQTTPassword', 'fpp-tests-old');
    await put(request, 'MQTTPassword', password);
    expect(sh(`test -e ${PWNED} && echo yes || echo no`).trim(), 'the password ran a command').toBe('no');
    // The control: the save provisioned the broker.
    expect(restarts()).toBe(1);
    const log = startBroker();
    expect(brokerTakes(password), `the broker didn't take the new password\n${log}`).toBe(true);
    expect(brokerTakes('fpp-tests-old')).toBe(false);
  });
});

test('turning the broker on with an MQTT password that has shell characters runs nothing', async ({ request }) => {
  // Regression: 97c553671, the escaping on its own: the password is the
  // stored one, read fresh by the request, so the stale value (above) plays
  // no part.  Unquoted, "a;touch b" ran touch as root.
  const password = `fpp-tests;touch ${PWNED};x $(touch ${PWNED})`;
  await keepingSettings(async () => {
    setSettingInFile('Service_MQTT_localbroker', '0');
    setSettingInFile('MQTTPassword', password);
    setSettingInFile('osPassword', password);
    await put(request, 'Service_MQTT_localbroker', '1');
    expect(sh(`test -e ${PWNED} && echo yes || echo no`).trim(), 'the password ran a command').toBe('no');
    const log = startBroker();
    expect(brokerTakes(password), `the broker didn't take the password\n${log}`).toBe(true);
  });
});

test('restoring a backup that turns the broker on gives it the restored MQTT password', async ({ request }) => {
  // Regression: 8f4f32d53.  A restore writes and applies one setting after
  // another in one request; WriteSettingToFile() didn't update the request's
  // settings, so Service_MQTT_localbroker, applied after MQTTPassword, made
  // the broker's password file from the player's old MQTT password.
  await keepingSettings(async () => {
    setSettingInFile('Service_MQTT_localbroker', '0');
    setSettingInFile('MQTTPassword', 'fpp-tests-before');
    const backup = {
      fpp_backup_version: '8.0',
      settings: { system_settings: [{ MQTTPassword: 'fpp-tests-restored', Service_MQTT_localbroker: '1' }] },
    };
    const r = await request.post('/backup.php', {
      multipart: {
        btnRestoreConfig: '1',
        restorearea: 'settings/system_settings',
        conffile: { name: 'fpp-tests-mqtt.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) },
      },
    });
    expect(r.ok()).toBe(true);
    // The control: the restore wrote both and turned the broker on.
    expect(sh('grep -E "^(MQTTPassword|Service_MQTT_localbroker) " /home/fpp/media/settings')).toContain('fpp-tests-restored');
    expect(restarts()).toBeGreaterThan(0);
    const log = startBroker();
    expect(brokerTakes('fpp-tests-restored'), `the broker didn't take the restored password\n${log}`).toBe(true);
    expect(brokerTakes('fpp-tests-before')).toBe(false);
  });
  sh('rm -f /fpp_restored');
});
