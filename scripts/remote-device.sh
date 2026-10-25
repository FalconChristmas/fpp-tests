#!/bin/sh
# A device run on a board too small for a runner of its own (an AM335x
# BeagleBone): the runner sits on another machine and drives the board over
# ssh. Run from the fpp-tests checkout:
#   scripts/remote-device.sh FPP_REF FLAVOR [pytest args...]
# The board is $DEVICE_BOARD (bbb, pb1, ...), whose host the runner's .env
# names as DEVICE_HOST_<BOARD> (DEVICE_HOST_BBB=...): an ssh host the
# runner's user reaches with a key, an account with passwordless sudo. One
# runner can serve several boards, one job at a time. DEVICE_HOST, if set,
# names the host directly. On the board:
#   ~/ci/fpp        an fpp checkout kept between runs, moved to FPP_REF, so
#                   make and ccache redo only what the commit changed
#   ~/ci/fpp-tests  this checkout, synced over
# The build goes through scripts/device-make.sh (nocc, on $NOCC_SERVERS, also
# from the .env). The board's own fppd and fppoled stop for the run (the
# scenarios drive the real GPIO lines) and start again however it ends. The
# results land in artifacts/ here, with meta.json flavored
# $DEVICE_FLAVOR, as the other device jobs leave them.
set -e
REF="$1"
FLAVOR="$2"
shift 2
if [ -z "$DEVICE_HOST" ]; then
    : "${DEVICE_BOARD:?}"
    var="DEVICE_HOST_$(printf '%s' "$DEVICE_BOARD" | tr a-z A-Z)"
    eval "DEVICE_HOST=\${$var:-}"
    : "${DEVICE_HOST:?set $var in the .env of the runner}"
fi
: "${DEVICE_FLAVOR:?}"
CI=ci
mkdir -p artifacts

on_board() {
    ssh -o BatchMode=yes -o ServerAliveInterval=30 "$DEVICE_HOST" "$@"
}

# The remote shell gets the arguments as one string: quote each.
squote() {
    printf '%s\n' "$1" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/"
}
quoted=""
for a in "$@"; do
    quoted="$quoted $(squote "$a")"
done

rsync -a --delete --exclude .git --exclude artifacts ./ "$DEVICE_HOST:$CI/fpp-tests/"

echo "::group::Check out fpp $REF"
on_board "set -e; cd $CI/fpp
    git fetch -q origin '$REF'
    git checkout -q --force FETCH_HEAD
    git submodule -q update --init --recursive
    git log -1 --format='%h %s'"
echo "::endgroup::"

# fpp, and the cape pinctrl tool the pinmux scenarios run (they skip
# without it).
build() {  # dir target
    on_board "cd $CI/fpp/$1 && CCACHE=ccache NOCC_SERVERS='$NOCC_SERVERS' sh ~/$CI/fpp-tests/scripts/device-make.sh '$2'" || {
        on_board "cat $CI/fpp/$1/build.log" > artifacts/build.log 2>/dev/null || true
        exit 1
    }
}
build src "$FLAVOR"
build capes/drivers/pinctrl pinctrl
# Its makefile makes it setuid, which as a non-root user's file puts the
# loader in secure mode when root runs it: LD_PRELOAD is dropped, and with it
# the scenarios' fake pinmux.
on_board "chmod ug-s $CI/fpp/capes/drivers/pinctrl/pinctrl"

# Under systemd-run, so a dropped ssh session doesn't take pytest with it
# halfway through: the run finishes and puts the board's services back.
status=0
on_board "set -e; cd $CI/fpp-tests
    restart=''
    for s in fppd fppoled; do
        if systemctl is-active --quiet \$s; then sudo systemctl stop \$s; restart=\"\$restart \$s\"; fi
    done
    sudo rm -rf artifacts
    sudo systemd-run --quiet --collect --wait --pipe --unit=fpp-tests-device \
        --working-directory=\$PWD env PYTHONDONTWRITEBYTECODE=1 \
        ./run-local.sh --fpp \$HOME/$CI/fpp -v -rA --junitxml=artifacts/junit.xml $quoted || status=\$?
    for s in \$restart; do sudo systemctl start \$s; done
    sudo chown -R \$(id -u):\$(id -g) artifacts 2>/dev/null || true
    exit \${status:-0}" || status=$?

rsync -a "$DEVICE_HOST:$CI/fpp-tests/artifacts/" artifacts/ || true
on_board "cat $CI/fpp/src/build.log" > artifacts/build.log 2>/dev/null || true
version=$(on_board "git -C $CI/fpp describe --tags --match='[0-9]*' 2>/dev/null || git -C $CI/fpp rev-parse --short HEAD")
sha=$(on_board "git -C $CI/fpp rev-parse HEAD")
printf '{"flavor":"%s","version":"%s","sha":"%s"}\n' "$DEVICE_FLAVOR" "$version" "$sha" > artifacts/meta.json
exit $status
