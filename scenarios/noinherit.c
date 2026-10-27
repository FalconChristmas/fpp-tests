/* noinherit.so: preloaded into a sanitizer-built fppd (by fppd.py, after
 * everything else in LD_PRELOAD) to take the sanitizer runtime back out of
 * LD_PRELOAD once fppd has loaded, so the processes fppd starts don't
 * inherit it.
 *
 * The runtime is preloaded first whenever anything else is preloaded: ASan
 * refuses to start unless its runtime comes first, and another preloaded
 * object -- libfaketime above all -- must not come ahead of TSan's:
 * libfaketime's pthread_cond_timedwait then reaches TSan's from inside, and
 * TSan reports unlocks of mutexes it never saw locked.  But a child that is
 * not built with the sanitizer can't run with its runtime preloaded.  With
 * libtsan a plain shell segfaults, so every script fppd ran -- a plugin's
 * callbacks, a Run Script -- failed.  With libasan the PipeWire tools die at
 * once (SIGILL), so pw-link never linked the persistent output stream and
 * every track started 3 s late, and pw-cli and pw-dump never answered.
 * fppd itself has its runtime already; what it passes on keeps everything
 * else that was preloaded.  (A sanitizer-built child loads its own runtime;
 * fppd.py sets verify_asan_link_order=0 so an ASan one doesn't refuse to
 * start with a shim preloaded ahead of it.)
 */
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>

static int is_runtime(const char* tok) {
    return strstr(tok, "libtsan.so") || strstr(tok, "libasan.so");
}

__attribute__((constructor)) static void drop_sanitizer_runtime(void) {
    const char* pre = getenv("LD_PRELOAD");
    if (!pre || !(strstr(pre, "libtsan.so") || strstr(pre, "libasan.so"))) {
        return;
    }
    size_t n = strlen(pre);
    char* out = malloc(n + 1);
    char* copy = strdup(pre);
    if (!out || !copy) {
        free(out);
        free(copy);
        return;
    }
    out[0] = '\0';
    char* save = NULL;
    for (char* tok = strtok_r(copy, " :", &save); tok; tok = strtok_r(NULL, " :", &save)) {
        if (is_runtime(tok)) {
            continue;
        }
        if (out[0]) {
            strcat(out, " ");
        }
        strcat(out, tok);
    }
    if (out[0]) {
        setenv("LD_PRELOAD", out, 1);
    } else {
        unsetenv("LD_PRELOAD");
    }
    free(out);
    free(copy);
}
