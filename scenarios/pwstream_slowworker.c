/* pwstream_slowworker.so: LD_PRELOAD into fppd to make the persistent PipeWire
 * output stream's worker (the "FPP-PWStream" thread) slow to react, as it is
 * on a loaded single-core box. Once $SLOWWORKER_ARM exists, the first time
 * that thread comes back from a condition-variable wait it sleeps
 * $SLOWWORKER_MS (default 1000), with the wait's mutex released, before
 * carrying on, so whatever woke it -- a track asking for another sink -- is
 * acted on that much later. Other threads, and every later wake, are left
 * alone.
 *
 * It also takes the ASan runtime back out of LD_PRELOAD once fppd has loaded,
 * as noinherit.c does TSan's: the stream checks its links with pw-link, which
 * dies at once ("Illegal instruction") with libasan preloaded, and every
 * track then waits out the 3 s it gives the stream.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

static int done;

__attribute__((constructor)) static void drop_asan_runtime(void) {
    const char* pre = getenv("LD_PRELOAD");
    if (!pre || !strstr(pre, "libasan.so")) {
        return;
    }
    char* out = calloc(1, strlen(pre) + 1);
    char* copy = strdup(pre);
    for (char* save = NULL, *tok = strtok_r(copy, " :", &save); tok; tok = strtok_r(NULL, " :", &save)) {
        if (strstr(tok, "libasan.so")) {
            continue;
        }
        if (*out) {
            strcat(out, " ");
        }
        strcat(out, tok);
    }
    setenv("LD_PRELOAD", out, 1);
    free(copy);
    free(out);
}

// Sleeps with the wait's mutex released, as if the wait had not returned yet:
// held, the other threads would only queue behind it.
static void maybe_stall(pthread_mutex_t* m) {
    char name[17] = "";
    const char* arm = getenv("SLOWWORKER_ARM");
    if (done || !arm || access(arm, F_OK) != 0) {
        return;
    }
    prctl(PR_GET_NAME, name);
    if (strcmp(name, "FPP-PWStream") != 0) {
        return;
    }
    done = 1;
    const char* ms = getenv("SLOWWORKER_MS");
    pthread_mutex_unlock(m);
    usleep((useconds_t)(ms ? atoi(ms) : 1000) * 1000);
    pthread_mutex_lock(m);
}

int pthread_cond_wait(pthread_cond_t* c, pthread_mutex_t* m) {
    static int (*real)(pthread_cond_t*, pthread_mutex_t*);
    if (!real) {
        real = dlsym(RTLD_NEXT, "pthread_cond_wait");
    }
    int r = real(c, m);
    maybe_stall(m);
    return r;
}

int pthread_cond_timedwait(pthread_cond_t* c, pthread_mutex_t* m, const struct timespec* t) {
    static int (*real)(pthread_cond_t*, pthread_mutex_t*, const struct timespec*);
    if (!real) {
        real = dlsym(RTLD_NEXT, "pthread_cond_timedwait");
    }
    int r = real(c, m, t);
    maybe_stall(m);
    return r;
}

int pthread_cond_clockwait(pthread_cond_t* c, pthread_mutex_t* m, clockid_t clk, const struct timespec* t) {
    static int (*real)(pthread_cond_t*, pthread_mutex_t*, clockid_t, const struct timespec*);
    if (!real) {
        real = dlsym(RTLD_NEXT, "pthread_cond_clockwait");
    }
    int r = real(c, m, clk, t);
    maybe_stall(m);
    return r;
}
