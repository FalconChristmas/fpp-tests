/* life_mainstall.so: LD_PRELOAD into fppd to stall its main loop on demand,
 * as a wedged decoder or a blocking call on the loop does.  The main loop
 * waits in epoll_wait() on every pass; while the file $LIFE_STALL_FILE
 * exists, that call on fppd's main thread (the one whose tid is the pid)
 * does not return.  On the first stalled call it creates
 * $LIFE_STALL_FILE.held, so a scenario knows the loop is stuck there.  The
 * call returns (as a timeout) once the file is removed.  Every other
 * epoll_wait() -- drogon's, the other threads' -- runs as usual.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/epoll.h>
#include <unistd.h>

int epoll_wait(int epfd, struct epoll_event* events, int maxevents, int timeout) {
    static int (*real)(int, struct epoll_event*, int, int);
    if (!real) {
        real = (int (*)(int, struct epoll_event*, int, int))dlsym(RTLD_NEXT, "epoll_wait");
    }
    const char* stall = getenv("LIFE_STALL_FILE");
    if (stall && gettid() == getpid() && access(stall, F_OK) == 0) {
        char held[4096];
        snprintf(held, sizeof(held), "%s.held", stall);
        int fd = open(held, O_WRONLY | O_CREAT | O_CLOEXEC, 0644);
        if (fd >= 0) {
            close(fd);
        }
        while (access(stall, F_OK) == 0) {
            usleep(50 * 1000);
        }
        return 0;
    }
    return real(epfd, events, maxevents, timeout);
}
