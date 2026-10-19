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
# recently used FPP_TESTS_KEEP_TREES.
# (touch only an existing tree: on a new one it would create a plain file.)
$DOCKER fpp-tests-env sh -c "if [ -d '$TREE' ]; then touch '$TREE'; fi; ls -1dt /work/*/ 2>/dev/null |
    tail -n +$((${FPP_TESTS_KEEP_TREES:-16} + 1)) | xargs -r rm -rf"

# Export the tree once per commit and flavor; flavors can't share object files.
# An export has no .git, so fppversion.sh reads the version from
# src/EXPORTED_VERSION instead of git describe.
if ! $DOCKER fpp-tests-env test -d "$TREE"; then
    git -C "$FPP" archive --format=tar "$SHA" |
        $DOCKER -i fpp-tests-env sh -c "exec 9> /work/.export.lock && flock 9 &&
            if [ -d '$TREE' ]; then cat > /dev/null; exit 0; fi &&
            rm -rf '$TREE.tmp' && mkdir -p '$TREE.tmp' && tar -x -C '$TREE.tmp' &&
            printf 'SOURCE_VERSION=%s\\nBRANCH=fpp-tests\\n' '$DESCRIBE' > '$TREE.tmp/src/EXPORTED_VERSION' &&
            mv '$TREE.tmp' '$TREE'"
fi
