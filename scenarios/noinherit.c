/* noinherit.so: preloaded into a TSan fppd (by fppd.py, after everything
 * else in LD_PRELOAD) to take the TSan runtime back out of LD_PRELOAD once
 * fppd has loaded, so the processes fppd starts don't inherit it.
 *
 * The runtime is preloaded first because another preloaded object --
 * libfaketime above all -- must not come ahead of it: libfaketime's
 * pthread_cond_timedwait then reaches TSan's from inside, and TSan reports
 * unlocks of mutexes it never saw locked.  But a child with libtsan
 * preloaded and no TSan-built program to run crashes as it starts (a plain
 * shell segfaults), so every script fppd ran -- a plugin's callbacks, a
 * Run Script -- failed.  fppd itself has its runtime already; what it
 * passes on keeps everything else that was preloaded.
 */
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>

__attribute__((constructor)) static void drop_tsan_runtime(void) {
    const char* pre = getenv("LD_PRELOAD");
    if (!pre || !strstr(pre, "libtsan.so")) {
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
        if (strstr(tok, "libtsan.so")) {
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
