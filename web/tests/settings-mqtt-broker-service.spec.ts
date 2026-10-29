import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';
import { putFile, settingInFile } from './settings-file';

// The Enable Local MQTT Broker box on the Settings page's Services tab turns
// the mosquitto service on and off, not just its config.  The player has no
// systemd, so systemctl is a stand-in that logs its calls (answering
// is-enabled as told); the broker is the real mosquitto, started from the
// conf.d snippet the PHP wrote, as mqtt-local-broker.spec.ts does.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SNIPPET = '/etc/mosquitto/conf.d/fpp_local_broker.conf';
const SYSTEMCTL = '/usr/local/bin/systemctl';
const MARK = 'fpp-tests-systemctl';
const CALLS = '/tmp/fpp-tests-systemctl.log';
const ENABLED = '/tmp/fpp-tests-mosquitto-enabled';
const CONF = '/tmp/fpp-tests-mosquitto.conf';
const LOG = '/tmp/fpp-tests-mosquitto.log';

function sh(script: string): string {
  return inPlayer('sh', '-c', script);
}

function cleanup() {
  sh(`pkill -x mosquitto; for i in $(seq 50); do pgrep -x mosquitto > /dev/null || break; sleep 0.1; done; ` +
    `grep -q ${MARK} ${SYSTEMCTL} 2>/dev/null && rm -f ${SYSTEMCTL}; ` +
    `rm -f /etc/mosquitto/passwd ${SNIPPET} ${CONF} ${LOG} ${CALLS} ${ENABLED}; true`);
}

test.beforeEach(() => {
  cleanup();
  const real = sh(`test -e ${SYSTEMCTL} && ! grep -q ${MARK} ${SYSTEMCTL} && echo real || true`).trim();
  if (real === 'real') throw new Error(`${SYSTEMCTL} is a real program in the player; not replacing it`);
  // is-enabled answers "enabled" once the test has made the file, else "disabled".
  putFile(SYSTEMCTL, `#!/bin/sh\n# ${MARK}\necho "$*" >> ${CALLS}\n` +
    `[ "$1" = is-enabled ] && { [ -e ${ENABLED} ] && echo enabled || echo disabled; }\nexit 0\n`);
  sh(`chmod 755 ${SYSTEMCTL}`);
});

test.afterEach(() => cleanup());

function calls(): string[] {
  return sh(`cat ${CALLS} 2>/dev/null || true`).split('\n').filter((l) => l !== '');
}

function brokerTakes(password: string): boolean {
  putFile(CONF, `log_dest file ${LOG}\ninclude_dir /etc/mosquitto/conf.d\n`);
  sh(`pkill -x mosquitto; touch ${LOG} && chmod 666 ${LOG} && mosquitto -c ${CONF} -d; ` +
    'for i in $(seq 50); do ss -ltn | grep -q ":1883 " && break; sleep 0.1; done');
  try {
    execFileSync('docker', ['exec', container, 'mosquitto_pub', '-h', '127.0.0.1', '-p', '1883',
      '-u', 'fpp', '-P', password, '-t', 'fpp-tests', '-m', 'x'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('the Services tab turns the local broker on and enables mosquitto, and off again stops and disables it', async ({ page }) => {
  // Feature: 683dc3cdb declared Service_MQTT_localbroker, so the Services
  // tab draws the box (settings-tabs-levels.spec.ts) and a click saves it.
  // Regression: b8cab40a7.  Turning it on only restarted mosquitto, which
  // stays down at the next boot on an image where the service is disabled;
  // turning it off restarted mosquitto, still enabled, without the snippet.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    setSettingInFile('Service_MQTT_localbroker', '0');
    setSettingInFile('MQTTPassword', 'fpp-tests-broker');
    await page.goto('/settings.php?tab=Services');
    const box = page.locator('#settingsManagerTabsContent .tab-pane.active #Service_MQTT_localbroker');
    await expect(box).toBeVisible({ timeout: 15_000 });

    let saved = page.waitForResponse((r) => r.url().endsWith('/api/settings/Service_MQTT_localbroker') && r.request().method() === 'PUT');
    await box.check();
    expect((await saved).ok()).toBe(true);
    expect(settingInFile('Service_MQTT_localbroker')).toBe('1');
    await expect.poll(calls, { message: 'mosquitto was not restarted' }).toContain('restart mosquitto');
    expect(calls()).toContain('is-enabled mosquitto');
    expect(calls(), 'the disabled service was not enabled').toContain('enable mosquitto');
    expect(brokerTakes('fpp-tests-broker'), 'the broker from the snippet did not take the MQTT password').toBe(true);

    sh(`: > ${CALLS}`);
    saved = page.waitForResponse((r) => r.url().endsWith('/api/settings/Service_MQTT_localbroker') && r.request().method() === 'PUT');
    await box.uncheck();
    expect((await saved).ok()).toBe(true);
    expect(settingInFile('Service_MQTT_localbroker')).toBe('0');
    expect(sh(`test -e ${SNIPPET} && echo yes || echo no`).trim(), 'the snippet was left').toBe('no');
    await expect.poll(calls, { message: 'mosquitto was not disabled' }).toContain('disable mosquitto');
    await expect.poll(calls, { message: 'mosquitto was not stopped' }).toContain('stop mosquitto');
    expect(calls(), 'mosquitto was restarted instead').not.toContain('restart mosquitto');
  });
});

test('turning the local broker on leaves an already enabled mosquitto as it is', async ({ request }) => {
  // Regression: b8cab40a7 (the is-enabled check): enable only when needed.
  await keepingSettings(async () => {
    setSettingInFile('Service_MQTT_localbroker', '0');
    sh(`touch ${ENABLED}`);
    const r = await request.put('/api/settings/Service_MQTT_localbroker', { data: '1' });
    expect(r.ok()).toBe(true);
    await expect.poll(calls).toContain('restart mosquitto');
    expect(calls()).toContain('is-enabled mosquitto');
    expect(calls()).not.toContain('enable mosquitto');
  });
});
