# Wire capture without an analyzer (AM62x)

Checks what a pin actually sends, on a PocketBeagle 2, with nothing attached.
Used to verify the PRU serial transmitter (DMX/LOR on a pin with no UART
transmit), which can't run in `run-local.sh`: the sandbox mounts `/sys`
read-only, and starting a PRU goes through remoteproc's sysfs files.

`padsample.c` (build on the device: `gcc -O2 -o padsample padsample.c`)
records every level change of one bit of a GPIO register, timestamped with the
ARM generic timer (`cntvct_el0`, 200 MHz on AM62x), plus every pause in its own
sampling long enough to hide an edge:

    padsample SECONDS BANK_PHYS_BASE REG_OFFSET BIT GAP_NS > capture.txt

For a pin driven as a GPIO output, sample the bank's OUT register, not IN_DATA:
`gpio_out` mode disables the pad's input buffer, so IN_DATA reads 0. For a
gpiochip whose sysfs device is `601000.gpio` and line N, the OUT register is
`0x601000 + 0x14 + (N / 32) * 0x28`, bit `N % 32` (P1-10 is `0x601000 0x14 7`).

Run it on the core fppd is not on, at real-time priority, or the sampler is
preempted exactly when fppd starts a frame and loses the start of every one:

    pid=$(pidof fppd); taskset -a -p 1 $pid
    chrt -f 80 taskset -c 1 ./padsample 10 0x601000 0x14 7 1500 > cap.txt
    taskset -a -p 3 $pid

Even so, expect a pause every couple of milliseconds, up to a few hundred
microseconds while fppd copies a frame into PRU memory over the same
interconnect. The decoders count only what was watched:

- `dmxdecode.py capture.txt BAUD PATTERN_HEX [stopbits]` checks DMX: breaks,
  mark-after-break, frame interval, bit time, and every watched slot against a
  repeating pattern after a 00 start code (use the channel tester's "RGB Single
  Color", e.g. `#A53C0F` on 1-512). A slot is judged only when all its sample
  points were watched; after a pause the slot index is re-derived from the
  character period, and a candidate start bit must frame and land on a whole
  period, so a data edge after a pause is never taken for a start bit.
- `framing.py capture.txt BAUD` checks start/stop framing and bit time for a
  stream with no breaks (LOR, Renard).

Run a control before believing a clean result: decode against a pattern one bit
off (`A53C0E`) and about a third of the data slots must come back bad.

The sampler resolves about 250 ns, which is enough for 250 kbaud and 1 Mbaud
serial but not for WS281x bits (1.25 us); string output can only be checked for
frame cadence this way.
