/* pl_slowloop.so: LD_PRELOAD into fppd to slow its main loop down on demand,
 * so a state the loop leaves behind at the end of one pass lasts until the
 * next.  The main loop waits in epoll_wait() on every pass; while the file
 * $PL_SLOWLOOP_FILE exists, that call on fppd's main thread (the one whose
 * tid is the pid) first sleeps $PL_SLOWLOOP_MS (default 400), then polls
 * without waiting.  Every other epoll_wait() runs as usual.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <sys/epoll.h>
#include <unistd.h>

int epoll_wait(int epfd, struct epoll_event* events, int maxevents, int timeout) {
    static int (*real)(int, struct epoll_event*, int, int);
    if (!real) {
        real = (int (*)(int, struct epoll_event*, int, int))dlsym(RTLD_NEXT, "epoll_wait");
    }
    const char* slow = getenv("PL_SLOWLOOP_FILE");
    if (slow && gettid() == getpid() && access(slow, F_OK) == 0) {
        const char* ms = getenv("PL_SLOWLOOP_MS");
        usleep((ms ? atoi(ms) : 400) * 1000);
        return real(epfd, events, maxevents, 0);
    }
    return real(epfd, events, maxevents, timeout);
}
