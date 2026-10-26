import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// The Troubleshooting page's RPI Power Supply readout (RPI Utils tab), on a
// player that claims to be a Raspberry Pi.  The command reads the PMIC through
// vcgencmd and the supply rating from the device tree's chosen/power node.
// The container has neither: vcgencmd is a stand-in that answers as a Pi 5
// did (its pmic_read_adc lines are a real Pi 5's), and for the device tree
// the command as troubleshoot-commands.json stores it is run with that path
// pointed at a stand-in node holding the cells a Pi 5's firmware writes.

test.skip(!container, 'changes the platform and runs the command inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const VCGENCMD = '/usr/bin/vcgencmd';
const NODE = '/sys/firmware/devicetree/base/chosen/power';
const FAKE_NODE = '/tmp/fpp-tests-chosen-power';
const PMIC_FILE = '/tmp/fpp-tests-pmic-adc.txt';

const PMIC = `\
 3V7_WL_SW_A current(0)=0.00000000A
   3V3_SYS_A current(1)=0.12589500A
   1V8_SYS_A current(2)=0.24203070A
  DDR_VDD2_A current(3)=0.00585558A
  DDR_VDDQ_A current(4)=0.00000000A
   1V1_SYS_A current(5)=0.19713790A
    0V8_SW_A current(6)=0.32108100A
  VDD_CORE_A current(7)=1.54489000A
   3V3_DAC_A current(17)=0.00000000A
   3V3_ADC_A current(18)=0.00024420A
   0V8_AON_A current(16)=0.00317460A
      HDMI_A current(22)=0.00879120A
 3V7_WL_SW_V volt(8)=3.72668700V
   3V3_SYS_V volt(9)=3.31838500V
   1V8_SYS_V volt(10)=1.80512600V
  DDR_VDD2_V volt(11)=1.10732500V
  DDR_VDDQ_V volt(12)=0.60659280V
   1V1_SYS_V volt(13)=1.10732500V
    0V8_SW_V volt(14)=0.80256330V
  VDD_CORE_V volt(15)=0.92835070V
   3V3_DAC_V volt(20)=3.32417200V
   3V3_ADC_V volt(21)=3.31318300V
   0V8_AON_V volt(19)=0.79999920V
      HDMI_V volt(23)=5.10808000V
     EXT5V_V volt(24)=5.09870000V
      BATT_V volt(25)=0.00000000V
`;

// A Pi 5's vcgencmd, with get_throttled reporting under-voltage and
// throttling now and since boot, and an optional PSU_MAX_CURRENT in the
// bootloader config; or (pi4) a Pi 4's, whose firmware has no pmic_read_adc.
function vcgencmd(opts: { pi4?: boolean; psuMaxCurrent?: number } = {}) {
  const pmic = opts.pi4
    ? 'echo "vc_gencmd_read_response returned -1"; echo \'error=1 error_msg="Command not registered"\'; exit 255'
    : `cat ${PMIC_FILE}`;
  putFile(PMIC_FILE, PMIC);
  putFile(VCGENCMD, `#!/bin/sh
case "$1" in
pmic_read_adc) ${pmic} ;;
get_throttled) echo throttled=0x50005 ;;
measure_temp) echo "temp=51.0'C" ;;
bootloader_config) echo BOOT_UART=1; ${opts.psuMaxCurrent ? `echo PSU_MAX_CURRENT=${opts.psuMaxCurrent}` : 'true'} ;;
*) exit 1 ;;
esac
`);
  inPlayer('chmod', '755', VCGENCMD);
}

// A chosen/power node: each cell a big-endian u32, as the firmware writes them.
function powerNode(cells: Record<string, number[]>) {
  const py = `import os, struct, sys, json
d = sys.argv[1]
os.makedirs(d, exist_ok=True)
for name, vals in json.loads(sys.argv[2]).items():
    open(os.path.join(d, name), "wb").write(struct.pack(">%dI" % len(vals), *vals))`;
  inPlayer('rm', '-rf', FAKE_NODE);
  inPlayer('python3', '-c', py, FAKE_NODE, JSON.stringify(cells));
}

// A USB-PD fixed-supply PDO: volts in 50 mV units, amps in 10 mA units.
const pdo = (volts: number, amps: number) => (Math.round(volts * 20) << 10) | Math.round(amps * 100);

// The command as troubleshoot-commands.json has it, run as
// troubleshootingHelper.php runs it, with the device tree node moved.
async function runWithNode(request: APIRequestContext): Promise<string> {
  const cmd: string = (await (await request.get('/troubleshoot-commands.json')).json())
    .CommandGroups.RPISPECIFIC.commands.PMICVOLTAGE.cmd;
  expect(cmd, 'the command reads the device tree node').toContain(NODE);
  return inPlayer('env', 'PATH=/bin:/usr/bin:/sbin:/usr/sbin', 'sh', '-c', cmd.split(NODE).join(FAKE_NODE));
}

let savedPlatform = '';
test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'Raspberry Pi' > ${PLATFORM}`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  inPlayer('rm', '-rf', VCGENCMD, FAKE_NODE, PMIC_FILE);
});

test('the RPI Utils tab reads out the Pi 5 supply: input voltage, PMIC power and the throttle flags', async ({ page }) => {
  // Feature: 949f22c12 (#3077): an RPI Power Supply command reads EXT5V_V,
  // VDD_CORE and the total PMIC power from vcgencmd pmic_read_adc, decodes
  // get_throttled, and says what a model without the ADC does not report.
  // And 1abcb5036: the power is also given as amps from the 5V input, to set
  // beside the supply rating, and a model with no chosen/power node has no
  // "negotiated supply current", only no rating.
  vcgencmd();
  await page.goto('/troubleshooting.php');
  await page.locator('#pills-RPISPECIFIC-tab').click();
  await expect(page.locator('#troubleshooting-hot-links-RPISPECIFIC a[href="#header_PMICVOLTAGE"]')).toHaveText('RPI Power Supply');
  const out = page.locator('#pills-RPISPECIFIC #command_PMICVOLTAGE');
  await expect(out).toContainText('RTC battery', { timeout: 30_000 });
  const lines = (await out.innerText()).split('\n');
  expect(lines).toEqual(expect.arrayContaining([
    'Input voltage (EXT5V_V): 5.10 V',
    'Core voltage (VDD_CORE): 0.93 V',
    'Core current (VDD_CORE): 1.54 A',
    'Estimated PMIC power: 2.82 W (about 0.55 A from the 5V input, not counting regulator losses, USB devices or HATs)',
    'Supply rating seen by the Pi: not available on this Raspberry Pi model',
    'Throttle/under-voltage (0x50005): under-voltage throttled under-voltage-since-boot throttled-since-boot',
    'SoC temperature: 51.0 C',
    'RTC battery: not available (Pi 5 RTC disabled or not present)',
  ]));
  expect(await out.innerText()).not.toContain('Negotiated');
});

test('a Pi without the PMIC ADC says the input voltage is not available', async ({ request }) => {
  // Feature: 949f22c12.  A Pi 4's firmware refuses pmic_read_adc.
  vcgencmd({ pi4: true });
  const out = await (await request.get('/troubleshootingHelper.php?key=PMICVOLTAGE', { timeout: 60_000 })).text();
  expect(out).toContain('Input voltage (EXT5V_V): not available on this Raspberry Pi model');
  expect(out).not.toContain('Estimated PMIC power');
  expect(out).toContain('Throttle/under-voltage (0x50005): under-voltage throttled');
});

test('the supply rating says where it came from and which USB current limit it selects', async ({ request }) => {
  // Regression: 1abcb5036.  chosen/power/max_current was printed as the
  // "Negotiated supply current", though it is the rating the firmware saw at
  // boot and usually nothing was negotiated: a supply with no USB-C current
  // signalling (a PoE HAT, the GPIO header) reads 0.9 A on a board that runs
  // normally.  Now the rating names its source, the USB-PD offers are
  // decoded, the USB port limit it selects is shown, and a boot-time USB
  // over-current is flagged.
  vcgencmd();
  const empty = { usbpd_power_data_objects: [0, 0, 0, 0, 0, 0, 0], usb_max_current_enable: [0], usb_over_current_detected: [0] };

  // What a real Pi 5 on a supply that advertises nothing reports.
  powerNode({ max_current: [900], ...empty });
  let out = await runWithNode(request);
  expect(out).toContain('Supply rating seen by the Pi: 0.9 A (nothing advertised: USB default current only');
  expect(out).toContain('USB port current limit: 600 mA total (supply not rated 5 A)');
  expect(out).not.toContain('USB-PD offers');
  expect(out).not.toContain('Negotiated');

  // A 27 W USB-PD supply.
  powerNode({ ...empty, max_current: [5000], usbpd_power_data_objects: [pdo(5, 5), pdo(9, 3), pdo(12, 2.25), pdo(15, 1.8), 0, 0, 0], usb_max_current_enable: [1] });
  out = await runWithNode(request);
  expect(out).toContain('Supply rating seen by the Pi: 5.0 A (negotiated over USB-PD)');
  expect(out).toContain('USB-PD offers from the supply: 5.00V/5.00A 9.00V/3.00A 12.00V/2.25A 15.00V/1.80A');
  expect(out).toContain('USB port current limit: 1.6 A total (supply rated 5 A)');

  // A USB-C 3 A advertisement, no PD, with the USB limit forced in config.txt
  // and an over-current at boot.
  powerNode({ ...empty, max_current: [3000], usb_max_current_enable: [1], usb_over_current_detected: [1] });
  out = await runWithNode(request);
  expect(out).toContain('Supply rating seen by the Pi: 3.0 A (USB-C current advertisement, no USB-PD)');
  expect(out).toContain('USB port current limit: 1.6 A total (forced by usb_max_current_enable=1 in config.txt)');
  expect(out).toContain('USB over-current: detected during boot');

  // PSU_MAX_CURRENT in the bootloader config skips the negotiation.
  vcgencmd({ psuMaxCurrent: 5000 });
  powerNode({ ...empty, max_current: [5000], usb_max_current_enable: [1] });
  out = await runWithNode(request);
  expect(out).toContain('Supply rating seen by the Pi: 5.0 A (set by PSU_MAX_CURRENT=5000 in the bootloader config; USB-PD negotiation skipped)');
});
