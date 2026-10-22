# Sourced by run.sh and run-web.sh, with HERE, FPP, REF and FLAVOR set: builds
# the image, picks the work tree for that commit and flavor, and exports the
# commit into it unless it is already there. Sets SHA, TREE, DESCRIBE and DOCKER
# (the docker run command with the work and ccache volumes mounted), and
# defines make_test_network.

SHA=$(git -C "$FPP" rev-parse --verify "$REF^{commit}")
TREE="/work/$(echo "$SHA" | cut -c1-12)-$FLAVOR"
DESCRIBE=$(git -C "$FPP" describe --tags --match='[0-9]*' "$SHA" 2>/dev/null || echo "$SHA")
echo "fpp $REF = $DESCRIBE ($SHA), flavor $FLAVOR"

docker build -q -t fpp-tests-env "$HERE/docker" > /dev/null
# build-fpp.sh rebuilds a tree built in another image: what the tree's
# makefiles found installed (src/.build-features) decides what fppd has in it.
IMAGE_ID=$(docker image inspect -f '{{.Id}}' fpp-tests-env)

# ccache lives in a named volume, or in a host directory when
# FPP_TESTS_CCACHE is set (CI caches that directory between runs).
CCACHE_MOUNT="fpp-tests-ccache:/ccache"
if [ -n "$FPP_TESTS_CCACHE" ]; then
    mkdir -p "$FPP_TESTS_CCACHE"
    CCACHE_MOUNT="$(cd "$FPP_TESTS_CCACHE" && pwd):/ccache"
fi
# fppd's exit path visits every descriptor up to the open-file limit, and
# some Docker setups (WSL's) default it to 2^30: under TSan that takes longer
# than any scenario waits for fppd to exit.
# FPP's own upload endpoints resolve to loopback in every container, so no
# run reaches them: the statistics server (setup's US answer turns
# statsPublish on, and fppd publishes two minutes after the opt-in) and the
# crash server (fppd's crash handler and the Diagnostic Report's Send).
# Something that would have contacted one finds nothing listening.
# web/tests/no-upload-egress.spec.ts checks it.
NO_UPLOAD_HOSTS="--add-host fppstats.falconchristmas.com:127.0.0.1 --add-host crashes.falconplayer.com:127.0.0.1"
DOCKER="docker run --rm --ulimit nofile=1048576:1048576 -v fpp-tests-work:/work -v $CCACHE_MOUNT -e FPP_TESTS_IMAGE=$IMAGE_ID -e FPP_TESTS_NOPCH $NO_UPLOAD_HOSTS"

# Each built tree is ~190MB (build-fpp.sh drops the objects); keep the most
# recently used FPP_TESTS_KEEP_TREES. A run holds a shared lock on its tree
# from the build to the end of its tests, and a tree is removed only when its
# exclusive lock is free: with several runs at once (separate fpp-tests
# copies), plain LRU removed trees that were mid-build or mid-test.
# (touch only an existing tree: on a new one it would create a plain file.)
$DOCKER fpp-tests-env sh -c "if [ -d '$TREE' ]; then touch '$TREE'; fi; ls -1dt /work/*/ 2>/dev/null | grep -v '\.tmp/\$' |
    tail -n +$((${FPP_TESTS_KEEP_TREES:-24} + 1)) | while read -r t; do flock -n -x \"\$t\" rm -rf \"\$t\" || true; done"

# Export the tree once per commit and flavor; flavors can't share object files.
# An export has no .git, so fppversion.sh reads the version from
# src/EXPORTED_VERSION instead of git describe.
# A tree with no src/Makefile is what an interrupted export or an old
# eviction left behind: export it again.
if ! $DOCKER fpp-tests-env test -f "$TREE/src/Makefile"; then
    git -C "$FPP" archive --format=tar "$SHA" |
        $DOCKER -i fpp-tests-env sh -c "exec 9> /work/.export.lock && flock 9 &&
            if [ -f '$TREE/src/Makefile' ]; then cat > /dev/null; exit 0; fi &&
            rm -rf '$TREE' '$TREE.tmp' && mkdir -p '$TREE.tmp' && tar -x -C '$TREE.tmp' &&
            printf 'SOURCE_VERSION=%s\\nBRANCH=fpp-tests\\n' '$DESCRIBE' > '$TREE.tmp/src/EXPORTED_VERSION' &&
            mv '$TREE.tmp' '$TREE'"
fi

# The container a run's fppd runs in gets a bridge network of its own
# (NETWORK, removed by remove_test_network). On Docker's default bridge every
# run's container shares one subnet, and fppd's MultiSync broadcasts and
# multicast reached the others: one run's fppd found another's over
# MultiSync, which showed up as a stray system or an extra socket in tests
# that count them. Networks a killed run left behind are pruned once they are
# an hour old and have no container on them.
# An argument tells apart the networks of one run (run.sh -j: one per shard).
make_test_network() {
    docker network prune -f --filter label=fpp-tests --filter until=1h > /dev/null 2>&1 || true
    NETWORK="fpp-tests-$$-$(date +%s)${1:+-$1}"
    if ! docker network create --label fpp-tests "$NETWORK" > /dev/null; then
        # Out of address pools, say: still run, but on the shared bridge.
        echo "warning: could not create network $NETWORK; using the default bridge" >&2
        NETWORK=bridge
    fi
}

remove_test_network() {
    if [ -n "$NETWORK" ] && [ "$NETWORK" != bridge ]; then
        docker network rm "$NETWORK" > /dev/null 2>&1 || true
    fi
}
