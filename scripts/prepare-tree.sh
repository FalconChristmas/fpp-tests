# Sourced by run.sh and run-web.sh, with HERE, FPP, REF and FLAVOR set: builds
# the image, picks the work tree for that commit and flavor, and exports the
# commit into it unless it is already there. Sets SHA, TREE, DESCRIBE and DOCKER
# (the docker run command with the work and ccache volumes mounted).

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
DOCKER="docker run --rm --ulimit nofile=1048576:1048576 -v fpp-tests-work:/work -v $CCACHE_MOUNT -e FPP_TESTS_IMAGE=$IMAGE_ID"

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
