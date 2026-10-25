#!/bin/bash
# The device scenarios for the device jobs, as root, from the fpp-tests
# checkout:
#   scripts/device-scenarios.sh [run-local.sh options] [pytest args]
# run-local.sh with these arguments, its results in artifacts/junit.xml.
#
# With HOST_PRU=1 (an AM62x board) it is two passes over the same scenarios:
# first everything but the ones that drive the real PRUs (marked host_pru:
# they use the real_pru fixture), then those alone under --host-pru. They
# can't share one: the FAKE_PRU scenarios need the PRUs hidden, the host_pru
# ones need them there. run-local.sh clears artifacts/ as it starts, so the
# first pass's is kept aside and the two put back together as one run's.
set -u
cd "$(dirname "$0")/.."
opts=()
while [ $# -gt 0 ]; do
    case "$1" in
    --fpp) opts+=("$1" "$2"); shift 2 ;;
    --host-*) opts+=("$1"); shift ;;
    *) break ;;
    esac
done

if [ "${HOST_PRU:-}" != 1 ]; then
    exec ./run-local.sh "${opts[@]}" "$@" --junitxml=artifacts/junit.xml
fi

status=0
./run-local.sh "${opts[@]}" "$@" -m "not host_pru" --junitxml=artifacts/junit-main.xml || status=$?
rm -rf artifacts.main
mv artifacts artifacts.main
./run-local.sh "${opts[@]}" --host-pru "$@" -m host_pru --junitxml=artifacts/junit-pru.xml
s=$?
# 5: none of these scenarios drives the real PRUs
[ $s = 0 ] || [ $s = 5 ] || status=$s
cp -a artifacts.main/. artifacts/
rm -rf artifacts.main
results=(artifacts/junit-main.xml)
[ -f artifacts/junit-pru.xml ] && results+=(artifacts/junit-pru.xml)
python3 scripts/merge-junit.py artifacts/junit.xml "${results[@]}" || status=1
exit $status
