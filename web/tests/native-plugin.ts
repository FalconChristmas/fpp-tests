import { inPlayer } from './container';

// A compiled (C++) plugin from fpp-tests' tools/, built inside the player
// against the fppd it serves (/opt/fpp/src, with libfpp's sanitizer) and
// installed as plugins/<name>/lib<name>.so with a callbacks script that
// answers "c++", the way scenarios/throw_plugin.py does it.  The test then
// loads it into the running fppd with POST /api/fppd/plugin/<name>/load, as
// the Plugin Manager does after an install.

const PLUGINS = '/home/fpp/media/plugins';

export function buildNativePlugin(source: string, name: string) {
  const dir = `${PLUGINS}/${name}`;
  inPlayer('sh', '-c', `set -e
    src=/opt/fpp/src
    san=$(ldd $src/libfpp.so | grep -q libasan && echo -fsanitize=address || true)
    [ -n "$san" ] || san=$(ldd $src/libfpp.so | grep -q libtsan && echo -fsanitize=thread || true)
    mkdir -p ${dir}
    c++ -std=gnu++20 -O1 -g -fPIC -shared $san -I$src -I/usr/include/jsoncpp /tests/tools/${source} \\
        -L$src -lfpp -ldrogon -ltrantor -Wl,-rpath,$src -o ${dir}/lib${name}.so
    printf '#!/bin/sh\\ncase "$1" in\\n    --list) echo "c++" ;;\\nesac\\n' > ${dir}/callbacks
    chmod 755 ${dir}/callbacks`);
  return dir;
}
