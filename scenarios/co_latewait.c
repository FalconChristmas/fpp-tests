/* co_latewait.so: LD_PRELOAD into fppd to hold the channel output thread
 * between deciding it has nothing to send and starting its idle wait.  A
 * timed condition wait of 2 s or more (only the idle wait is that long) on
 * the thread named FPP-ChannelOut sleeps $CO_LATEWAIT_MS (default 1500)
 * before the real wait.  The mutex is still held during the sleep, as it is
 * for a thread that hasn't reached its wait yet: a notify sent then without
 * it is lost, and a starter that takes it waits until the wait has begun.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

static void maybe_sleep(clockid_t clock, const struct timespec* abstime) {
    char name[17] = { 0 };
    prctl(PR_GET_NAME, name);
    if (strcmp(name, "FPP-ChannelOut") != 0 || !abstime) {
        return;
    }
    struct timespec now;
    clock_gettime(clock, &now);
    double left = (abstime->tv_sec - now.tv_sec) + (abstime->tv_nsec - now.tv_nsec) / 1e9;
    if (left >= 2.0) {
        const char* ms = getenv("CO_LATEWAIT_MS");
        usleep((ms ? atoi(ms) : 1500) * 1000);
    }
}

int pthread_cond_clockwait(pthread_cond_t* cond, pthread_mutex_t* mutex, clockid_t clock,
                           const struct timespec* abstime) {
    static int (*real)(pthread_cond_t*, pthread_mutex_t*, clockid_t, const struct timespec*);
    if (!real) {
        real = (int (*)(pthread_cond_t*, pthread_mutex_t*, clockid_t, const struct timespec*))
            dlsym(RTLD_NEXT, "pthread_cond_clockwait");
    }
    maybe_sleep(clock, abstime);
    return real(cond, mutex, clock, abstime);
}

int pthread_cond_timedwait(pthread_cond_t* cond, pthread_mutex_t* mutex, const struct timespec* abstime) {
    static int (*real)(pthread_cond_t*, pthread_mutex_t*, const struct timespec*);
    if (!real) {
        real = (int (*)(pthread_cond_t*, pthread_mutex_t*, const struct timespec*))
            dlvsym(RTLD_NEXT, "pthread_cond_timedwait", "GLIBC_2.3.2");
        if (!real) {
            real = (int (*)(pthread_cond_t*, pthread_mutex_t*, const struct timespec*))
                dlsym(RTLD_NEXT, "pthread_cond_timedwait");
        }
    }
    /* libstdc++ only falls back to this, on CLOCK_REALTIME, without clockwait */
    maybe_sleep(CLOCK_REALTIME, abstime);
    return real(cond, mutex, abstime);
}
