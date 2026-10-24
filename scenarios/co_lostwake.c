/* co_lostwake.so: LD_PRELOAD into fppd to hold a threaded output's worker
 * between checking for a frame and starting its untimed wait for the next.
 * The worker is the thread that writes to $CO_LOSTWAKE_DEVICE (a path such
 * as /dev/pts/3; output worker threads often have no name of their own to go
 * by, see co_slowwrite.c).  Once it has written there, each untimed condition
 * wait it makes sleeps $CO_LOSTWAKE_MS (default 1000) before the real wait,
 * with the mutex still held, as a worker that has checked and not yet waited
 * is: a frame handed over without that mutex is notified to nobody.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

static volatile pid_t worker;

ssize_t write(int fd, const void* buf, size_t count) {
    static ssize_t (*real)(int, const void*, size_t);
    if (!real) {
        real = (ssize_t(*)(int, const void*, size_t))dlsym(RTLD_NEXT, "write");
    }
    const char* want = getenv("CO_LOSTWAKE_DEVICE");
    if (want && *want && fd > 2) {
        char link[64], path[256];
        snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
        ssize_t n = readlink(link, path, sizeof(path) - 1);
        if (n > 0) {
            path[n] = 0;
            if (strcmp(path, want) == 0) {
                worker = gettid();
            }
        }
    }
    return real(fd, buf, count);
}

int pthread_cond_wait(pthread_cond_t* cond, pthread_mutex_t* mutex) {
    static int (*real)(pthread_cond_t*, pthread_mutex_t*);
    if (!real) {
        real = (int (*)(pthread_cond_t*, pthread_mutex_t*))
            dlvsym(RTLD_NEXT, "pthread_cond_wait", "GLIBC_2.3.2");
        if (!real) {
            real = (int (*)(pthread_cond_t*, pthread_mutex_t*))dlsym(RTLD_NEXT, "pthread_cond_wait");
        }
    }
    if (worker && gettid() == worker) {
        const char* ms = getenv("CO_LOSTWAKE_MS");
        usleep((ms ? atoi(ms) : 1000) * 1000);
    }
    return real(cond, mutex);
}
