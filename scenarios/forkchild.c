/* forkchild.so: LD_PRELOAD into fppd to catch a forked child that does
 * more than exec.  fppd is threaded, so between fork() and exec the child
 * may only make async-signal-safe calls: a lock another thread held at the
 * fork stays held in the child for good, and the child hangs on it.
 *
 * Armed only in fppd itself (an exec'd child loads this afresh, unarmed).
 * In a child forked from fppd, setenv() and the pthread mutex and rwlock
 * lock calls append their name to $FORKCHILD_LOG and _exit(97) instead:
 * the child dies at once, whether or not the lock happened to be free.
 *
 * The one lock a child may take is on a mutex it initialized itself after
 * the fork: no other thread can have held that one. A --coverage build's
 * runtime does exactly this -- its fork() wrapper re-initializes its mutex
 * in the child, and its exec wrappers take it to write out the counters
 * before exec -- and nothing else is let through.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int armed;
static volatile int inChild;
static char logPath[512];
// Mutexes initialized in this child since the fork.
static pthread_mutex_t* fresh[16];
static int nfresh;

static void caught(const char* what) {
    if (logPath[0]) {
        int fd = open(logPath, O_WRONLY | O_APPEND | O_CREAT, 0644);
        if (fd >= 0) {
            write(fd, what, strlen(what));
            write(fd, "\n", 1);
            close(fd);
        }
    }
    _exit(97);
}

static void child(void) {
    if (armed) {
        inChild = 1;
    }
}

static int isFresh(pthread_mutex_t* m) {
    for (int i = 0; i < nfresh; i++) {
        if (fresh[i] == m) return 1;
    }
    return 0;
}

#define REAL(fn) \
    static __typeof__(&fn) real; \
    if (!real) real = (__typeof__(&fn))dlsym(RTLD_NEXT, #fn)

__attribute__((constructor)) static void init(void) {
    const char* log = getenv("FORKCHILD_LOG");
    if (strcmp(program_invocation_short_name, "fppd") != 0 || !log) {
        return;
    }
    strncpy(logPath, log, sizeof(logPath) - 1);
    armed = 1;
    pthread_atfork(NULL, NULL, child);
}

int setenv(const char* n, const char* v, int o) {
    REAL(setenv);
    if (inChild) caught("setenv");
    return real(n, v, o);
}

int pthread_mutex_init(pthread_mutex_t* m, const pthread_mutexattr_t* a) {
    REAL(pthread_mutex_init);
    if (inChild && !isFresh(m) && nfresh < (int)(sizeof(fresh) / sizeof(fresh[0]))) {
        fresh[nfresh++] = m;
    }
    return real(m, a);
}

int pthread_mutex_lock(pthread_mutex_t* m) {
    REAL(pthread_mutex_lock);
    if (inChild && !isFresh(m)) caught("pthread_mutex_lock");
    return real(m);
}

int pthread_mutex_timedlock(pthread_mutex_t* m, const struct timespec* t) {
    REAL(pthread_mutex_timedlock);
    if (inChild && !isFresh(m)) caught("pthread_mutex_timedlock");
    return real(m, t);
}

int pthread_mutex_clocklock(pthread_mutex_t* m, clockid_t c, const struct timespec* t) {
    REAL(pthread_mutex_clocklock);
    if (inChild && !isFresh(m)) caught("pthread_mutex_clocklock");
    return real(m, c, t);
}

int pthread_rwlock_rdlock(pthread_rwlock_t* l) {
    REAL(pthread_rwlock_rdlock);
    if (inChild) caught("pthread_rwlock_rdlock");
    return real(l);
}

int pthread_rwlock_wrlock(pthread_rwlock_t* l) {
    REAL(pthread_rwlock_wrlock);
    if (inChild) caught("pthread_rwlock_wrlock");
    return real(l);
}
