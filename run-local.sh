#!/bin/sh
# Run the scenario suite against an fpp tree as it is built right now --
# normally /opt/fpp on an FPP device, uncommitted changes and all. Nothing is
# exported or built: run `make` (or `make debug`, `make tsan`) in the tree
# first, then this.
#
#   ./run-local.sh [--fpp DIR] [--host-audio] [--host-pinctrl] [--host-modules] [--host-pru] [pytest args...]
#
# --fpp           the fpp tree whose src/fppd to test (default /opt/fpp)
# --host-audio    media scenarios play through the device's own PipeWire --
#                 its real sound card -- instead of a private null sink, to
#                 measure against the card's clock. Only the PipeWire socket
#                 directory is shared; the test fppd uses the device's volume
#                 setting so it doesn't change it. Audible on the device.
# --host-pinctrl  the real pinctrl instead of the stub below. It writes the
#                 pad registers: a test fppd then re-muxes the device's pins.
# --host-modules  keep the ability to load and unload kernel modules, and the
#                 real modprobe/rmmod/insmod, instead of the stubs below.
# --host-pru      on a BeagleBone, the real PRUs instead of hiding them (below):
#                 /dev/mem, /lib/firmware and remoteproc, its state and
#                 firmware files writable. A test fppd then loads and runs PRU
#                 programs, so stop the device's own fppd first. Without
#                 --host-pinctrl too, no pad is muxed to a PRU, so nothing a
#                 PRU drives reaches a pin.
#
# The device's own fppd keeps running. Each test fppd runs in private mount,
# network and PID namespaces, set up below, so that it cannot reach the
# device's show, network, files or processes:
#   - its own PID namespace, whose init (scripts/ns-init.py) reaps orphans
#     and, when the run ends, takes down everything the run started -- a
#     test fppd, an fppoled a scenario ran, anything they forked -- however
#     the run ended (pytest killed by a lost ssh session or a timeout too):
#     a leftover test fppoled once fought the device's own for its display
#     for hours;
#   - a loopback-only network: no port clashes, nothing onto the show network;
#   - its own /tmp, /run and /dev/shm (command socket, PipeWire, D-Bus, mDNS);
#   - an overlay over the tree: fppd reads the real tree, but everything it
#     writes there (media_root.txt, www/warnings*.json) lands in a scratch
#     layer, so the device's fppd and web UI never see it;
#   - no sound cards, SPI devices as /dev/null (fppd probes SPI0 for a GPIO
#     expander at startup), a read-only /sys of its own (its /sys/class/net
#     lists the namespace's interfaces), and a scratch HOME;
#   - when the tree under test is not /opt/fpp, an overlay over /opt/fpp as
#     well: cape configs are read from /opt/fpp/capes whatever the tree, so
#     a scenario writes its own there;
#   - an overlay over /home/fpp/media and no I2C buses: cape detection, which
#     fppd re-runs when an output first asks for a cape config, hardcodes
#     /home/fpp/media. On the bus it would find the cape's EEPROM, fail to
#     bind it through the read-only /sys, wait 17 s, and delete the device's
#     own tmp/eeprom.bin. The device's EEPROM is offered as a virtual one
#     (config/cape-eeprom.bin) in the overlay instead, so the test fppd still
#     sees the cape -- as unsigned, since a signature is bound to the bus;
#   - pinctrl (a Raspberry Pi's writes the pad registers directly) as a stub
#     that only logs its calls to /tmp/pinctrl.log, so no pad is re-muxed;
#   - no kernel modules loaded or unloaded: CAP_SYS_MODULE is dropped, and
#     modprobe, rmmod, insmod and depmod are a stub that logs its calls to
#     /tmp/kmod.log and succeeds (lsmod and modinfo are the real ones).
#     Some outputs swap modules themselves -- RGBMatrix's Init unloads the
#     Pi's sound card driver -- which on a device took its sound card away.
#   The real pinctrl and kmod stay reachable for a scenario that needs them
#   for itself (hosttools.py); --host-pinctrl/--host-modules give them to
#   fppd as well.
#
# On a BeagleBone the PRUs are hidden from the test fppd, which would
# otherwise map the live PRUSS through /dev/mem and install firmware into
# the real /lib/firmware -- under a running show's outputs:
#   - an empty /sys/class/remoteproc, which puts an AM62x fppd in its
#     FAKE_PRU mode: PRU memory is anonymous memory, nothing is started, and
#     the outputs' Init, PrepData and SendData run against a PRU that never
#     answers;
#   - an empty /lib/firmware, and /dev/mem as /dev/null (an AM335x fppd has
#     no FAKE_PRU mode; its PRU outputs fail to start instead).
# GPIO lines are still the real ones. The GPIO scenarios pick lines nothing
# holds (on a cape with an OLED and buttons, fppoled holds the buttons'
# lines) and skip where there are none; stop the device's fppd first if one
# of its outputs is on a line a scenario drives.
#
# Needs root (for the namespaces). Installs python3-pytest, python3-zstandard
# and faketime if missing.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
TREE=/opt/fpp
while [ $# -gt 0 ]; do
    case "$1" in
    --fpp) TREE="$2"; shift 2 ;;
    --host-audio) export FPP_TESTS_HOST_AUDIO=1; shift ;;
    --host-pinctrl) export FPP_TESTS_HOST_PINCTRL=1; shift ;;
    --host-modules) export FPP_TESTS_HOST_MODULES=1; shift ;;
    --host-pru) export FPP_TESTS_HOST_PRU=1; shift ;;
    *) break ;;
    esac
done
TREE=$(cd "$TREE" && pwd)

if [ "$(uname -s)" != "Linux" ]; then
    echo "run-local.sh needs Linux namespaces; use run.sh (Docker) on this machine" >&2
    exit 2
fi
if [ "$(id -u)" != 0 ]; then
    echo "run-local.sh needs root for its private namespaces (try sudo)" >&2
    exit 2
fi
# /home/fpp/media is overlaid below, so the artifacts written under this
# checkout would land in the scratch layer and vanish with the namespace.
case "$(cd "$HERE" && pwd -P)/" in
/home/fpp/media/*)
    echo "run-local.sh writes its artifacts next to itself, which is under /home/fpp/media" \
         "and hidden by its overlay; check fpp-tests out somewhere else" >&2
    exit 2 ;;
esac
if [ ! -x "$TREE/src/fppd" ]; then
    echo "$TREE/src/fppd is not built; run make in $TREE/src first" >&2
    exit 2
fi
# pytest runs the suite; zstandard writes zstd FSEQ files; libfaketime lets
# the calendar scenarios fake fppd's clock (they skip without it).
MISSING=""
python3 -c "import pytest" 2>/dev/null || MISSING="$MISSING python3-pytest"
python3 -c "import zstandard" 2>/dev/null || MISSING="$MISSING python3-zstandard"
ls /usr/lib/*/faketime/libfaketimeMT.so.1 > /dev/null 2>&1 || MISSING="$MISSING faketime"
if [ -n "$MISSING" ]; then
    echo "installing:$MISSING"
    apt-get -q update > /dev/null
    DEBIAN_FRONTEND=noninteractive apt-get -q -y install --no-install-recommends $MISSING
fi

ARTIFACTS="$HERE/artifacts"
rm -rf "$ARTIFACTS"
mkdir -p "$ARTIFACTS"

echo "fpp tree $TREE: $(cd "$TREE" && git describe --tags --dirty 2>/dev/null || echo unknown)," \
     "fppd built $(date -r "$TREE/src/fppd" '+%Y-%m-%d %H:%M')"

BEAGLE=""
if grep -qi beagle /proc/device-tree/model 2>/dev/null; then
    BEAGLE=1
fi

# The device's PipeWire has no PID in the run's PID namespace; a scenario
# that stalls it (--host-audio) asks scripts/pipewire-stall.py, out here.
if [ -n "$FPP_TESTS_HOST_AUDIO" ]; then
    FPP_TESTS_STALL_DIR=$(mktemp -d /run/fpp-tests-stall.XXXXXX)
    mkfifo "$FPP_TESTS_STALL_DIR/fifo"
    python3 "$HERE/scripts/pipewire-stall.py" "$FPP_TESTS_STALL_DIR" $$ &
    export FPP_TESTS_STALL_DIR
fi

export FPP_TREE="$TREE" FPP_TESTS_HERE="$HERE" FPP_TESTS_ARTIFACTS="$ARTIFACTS" FPP_TESTS_BEAGLE="$BEAGLE"

# unshare makes every mount in the new namespace private, so nothing below is
# visible to the host or outlives the run.
exec unshare --mount --net --pid --fork --kill-child --mount-proc sh -c '
    set -e
    ip link set lo up
    mount -t tmpfs -o mode=1777 tmpfs /tmp
    if [ -n "$FPP_TESTS_HOST_AUDIO" ]; then
        # Keep a handle on the device PipeWire socket dir before /run goes.
        mkdir /tmp/host-pipewire /tmp/host-stall
        mount --bind /run/pipewire-fpp /tmp/host-pipewire
        mount --bind "$FPP_TESTS_STALL_DIR" /tmp/host-stall
    fi
    for d in /run /dev/shm; do
        mount -t tmpfs -o mode=1777 tmpfs "$d"
    done
    if [ -n "$FPP_TESTS_HOST_AUDIO" ]; then
        mkdir /run/pipewire-fpp "$FPP_TESTS_STALL_DIR"
        mount --bind /tmp/host-pipewire /run/pipewire-fpp
        mount --bind /tmp/host-stall "$FPP_TESTS_STALL_DIR"
    fi
    mkdir -p /tmp/overlay/upper /tmp/overlay/work /tmp/home
    mount -t overlay overlay \
        -o "lowerdir=$FPP_TREE,upperdir=/tmp/overlay/upper,workdir=/tmp/overlay/work" "$FPP_TREE"
    if [ -d /opt/fpp ] && [ "$FPP_TREE" != /opt/fpp ]; then
        mkdir -p /tmp/overlay-opt/upper /tmp/overlay-opt/work
        mount -t overlay overlay \
            -o "lowerdir=/opt/fpp,upperdir=/tmp/overlay-opt/upper,workdir=/tmp/overlay-opt/work" /opt/fpp
    fi
    if [ -d /home/fpp/media ]; then
        mkdir -p /tmp/overlay-media/upper /tmp/overlay-media/work
        mount -t overlay overlay \
            -o "lowerdir=/home/fpp/media,upperdir=/tmp/overlay-media/upper,workdir=/tmp/overlay-media/work" /home/fpp/media
        if [ -f /home/fpp/media/tmp/eeprom.bin ] && [ ! -e /home/fpp/media/config/cape-eeprom.bin ]; then
            cp /home/fpp/media/tmp/eeprom.bin /home/fpp/media/config/cape-eeprom.bin
        fi
    fi
    for f in /dev/i2c-*; do
        if [ -e "$f" ]; then mount --bind /dev/null "$f"; fi
    done
    if [ -d /dev/snd ]; then mount -t tmpfs tmpfs /dev/snd; fi
    for f in /dev/spidev*; do
        if [ -e "$f" ]; then mount --bind /dev/null "$f"; fi
    done
    # A sysfs of our own, not a bind of the host one: /sys/class/net lists
    # the network namespace sysfs was mounted in, so the bound one showed the
    # host interfaces and none of a scenario dummy ones (fppd counts qdisc
    # drops only on the interfaces it finds there).
    mount -t sysfs sysfs /sys
    if [ -n "$FPP_TESTS_BEAGLE" ] && [ -z "$FPP_TESTS_HOST_PRU" ]; then
        if [ -d /sys/class/remoteproc ]; then
            mount -t tmpfs -o mode=755 tmpfs /sys/class/remoteproc
        fi
        if [ -d /lib/firmware ]; then
            mount -t tmpfs -o mode=755 tmpfs /lib/firmware
        fi
        if [ -e /dev/mem ]; then mount --bind /dev/null /dev/mem; fi
    fi
    mount -o remount,bind,ro /sys
    if [ -n "$FPP_TESTS_BEAGLE" ] && [ -n "$FPP_TESTS_HOST_PRU" ]; then
        # the remoteproc directory of each core writable again, for its state
        # and firmware files
        for r in /sys/class/remoteproc/remoteproc*; do
            d=$(readlink -f "$r")
            mount --bind "$d" "$d" && mount -o remount,bind,rw "$d"
        done
    fi
    # The real pinctrl and kmod, kept where hosttools.py finds them, before
    # stubs go over them.
    H=/run/fpp-tests-host
    mkdir -p $H
    PINCTRL=$(command -v pinctrl || true)
    if [ -n "$PINCTRL" ]; then
        PINCTRL=$(readlink -f "$PINCTRL")
        touch $H/pinctrl; mount --bind "$PINCTRL" $H/pinctrl
        if [ -z "$FPP_TESTS_HOST_PINCTRL" ]; then
            printf "#!/bin/sh\necho \"\$*\" >> /tmp/pinctrl.log\n" > $H/pinctrl-stub
            chmod 755 $H/pinctrl-stub
            mount --bind $H/pinctrl-stub "$PINCTRL"
        fi
    fi
    KMOD=$(readlink -f /usr/bin/kmod 2>/dev/null || true)
    if [ -x "$KMOD" ]; then
        touch $H/kmod; mount --bind "$KMOD" $H/kmod
        # kmod picks its applet by the name it was run as
        for n in lsmod modinfo modprobe rmmod insmod depmod; do ln -s kmod $H/$n; done
        if [ -z "$FPP_TESTS_HOST_MODULES" ]; then
            cat > $H/kmod-stub << "EOS"
#!/bin/sh
n=$(basename "$0")
case "$n" in
    lsmod|modinfo) exec /run/fpp-tests-host/$n "$@" ;;
    kmod) case "$1" in modprobe|rmmod|insmod|depmod|insert|remove) ;; *) exec /run/fpp-tests-host/kmod "$@" ;; esac ;;
esac
echo "$n $*" >> /tmp/kmod.log
exit 0
EOS
            chmod 755 $H/kmod-stub
            mount --bind $H/kmod-stub "$KMOD"
        fi
    fi
    export FPP_TESTS_HOST_TOOLS=$H
    export HOME=/tmp/home XDG_CACHE_HOME=/tmp/home/.cache
    cd "$FPP_TESTS_HERE"
    if [ $# -eq 0 ]; then set -- scenarios; fi
    set -- python3 "$FPP_TESTS_HERE/scripts/ns-init.py" python3 -m pytest -p no:cacheprovider "$@"
    if [ -z "$FPP_TESTS_HOST_MODULES" ]; then
        set -- setpriv --bounding-set -sys_module --inh-caps -sys_module "$@"
    fi
    exec "$@"
' sh "$@"
