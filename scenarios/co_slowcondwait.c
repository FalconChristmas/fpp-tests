/* co_slowcondwait.so: LD_PRELOAD into fppd to widen the gap between a send
 * worker finishing a send and its next wait starting.  On a thread whose
 * name (prctl PR_GET_NAME) starts with $CO_SLOWCONDWAIT_THREAD, the first
 * pthread_cond_wait() after a sendmmsg() sleeps $CO_SLOWCONDWAIT_MS (default
 * 25) before the real wait.  The mutex is still held during the sleep, as it
 * is for a thread that has checked its condition and not yet reached its
 * wait, so a notify sent then without that mutex is lost, and one sent with
 * it waits until the wait has begun.  Only once per send: idle wakeups
 * (notify_all to every worker) go straight back to waiting, or the sleeps,
 * each holding the mutex, would add up to more than a frame.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>

static __thread int sent;

static int matches(void) {
    const char* want = getenv("CO_SLOWCONDWAIT_THREAD");
    if (!want || !*want) {
        return 0;
    }
    char name[17] = { 0 };
    prctl(PR_GET_NAME, name);
    return strncmp(name, want, strlen(want)) == 0;
}

int sendmmsg(int fd, struct mmsghdr* msgs, unsigned int vlen, int flags) {
    static int (*real)(int, struct mmsghdr*, unsigned int, int);
    if (!real) {
        real = (int (*)(int, struct mmsghdr*, unsigned int, int))dlsym(RTLD_NEXT, "sendmmsg");
    }
    if (matches()) {
        sent = 1;
    }
    return real(fd, msgs, vlen, flags);
}

int pthread_cond_wait(pthread_cond_t* cond, pthread_mutex_t* mutex) {
    static int (*real)(pthread_cond_t*, pthread_mutex_t*);
    if (!real) {
        /* the default version: GLIBC_2.3.2 on x86_64, the base version on
         * aarch64, which has no older one */
        real = (int (*)(pthread_cond_t*, pthread_mutex_t*))dlvsym(RTLD_NEXT, "pthread_cond_wait", "GLIBC_2.3.2");
        if (!real) {
            real = (int (*)(pthread_cond_t*, pthread_mutex_t*))dlsym(RTLD_NEXT, "pthread_cond_wait");
        }
    }
    if (sent) {
        sent = 0;
        const char* ms = getenv("CO_SLOWCONDWAIT_MS");
        usleep((ms ? atoi(ms) : 25) * 1000);
    }
    return real(cond, mutex);
}
