/* co_sseclient.so: LD_PRELOAD into fppd to make the preview clients of one
 * listening port slow, without a slow reader on the other end (a real one
 * keeps its socket buffer full, so fppd skips whole frames and never waits).
 *
 * Connections accept()ed on a socket bound to port $CO_SSE_PORT are
 * tracked.  With $CO_SSE_MODE=trickle, write() to one alternately takes at
 * most 16 bytes and fails with EAGAIN, and poll() on it sleeps
 * min(50 ms, timeout) and then reports it writable: the partial write that
 * reaches a writer's mid-chunk wait.  With $CO_SSE_MODE=stall, every write()
 * to one fails with EAGAIN.  close() forgets the fd.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#define MAXFD 4096
static unsigned char tracked[MAXFD]; /* 1 = tracked, 2 = tracked, next write fails */

static int mode(void) {
    const char* m = getenv("CO_SSE_MODE");
    if (m && strcmp(m, "stall") == 0) {
        return 2;
    }
    return 1;
}

static void track(int listener, int fd) {
    const char* want = getenv("CO_SSE_PORT");
    if (fd < 0 || fd >= MAXFD || !want) {
        return;
    }
    struct sockaddr_storage ss;
    socklen_t len = sizeof(ss);
    if (getsockname(listener, (struct sockaddr*)&ss, &len) != 0) {
        return;
    }
    int port = -1;
    if (ss.ss_family == AF_INET) {
        port = ntohs(((struct sockaddr_in*)&ss)->sin_port);
    } else if (ss.ss_family == AF_INET6) {
        port = ntohs(((struct sockaddr_in6*)&ss)->sin6_port);
    }
    if (port == atoi(want)) {
        tracked[fd] = 1;
    }
}

int accept(int s, struct sockaddr* addr, socklen_t* len) {
    static int (*real)(int, struct sockaddr*, socklen_t*);
    if (!real) {
        real = (int (*)(int, struct sockaddr*, socklen_t*))dlsym(RTLD_NEXT, "accept");
    }
    int fd = real(s, addr, len);
    track(s, fd);
    return fd;
}

int accept4(int s, struct sockaddr* addr, socklen_t* len, int flags) {
    static int (*real)(int, struct sockaddr*, socklen_t*, int);
    if (!real) {
        real = (int (*)(int, struct sockaddr*, socklen_t*, int))dlsym(RTLD_NEXT, "accept4");
    }
    int fd = real(s, addr, len, flags);
    track(s, fd);
    return fd;
}

ssize_t write(int fd, const void* buf, size_t count) {
    static ssize_t (*real)(int, const void*, size_t);
    if (!real) {
        real = (ssize_t(*)(int, const void*, size_t))dlsym(RTLD_NEXT, "write");
    }
    if (fd >= 0 && fd < MAXFD && tracked[fd]) {
        if (mode() == 2 || tracked[fd] == 2) {
            tracked[fd] = 1;
            errno = EAGAIN;
            return -1;
        }
        tracked[fd] = 2;
        return real(fd, buf, count < 16 ? count : 16);
    }
    return real(fd, buf, count);
}

int poll(struct pollfd* fds, nfds_t nfds, int timeout) {
    static int (*real)(struct pollfd*, nfds_t, int);
    if (!real) {
        real = (int (*)(struct pollfd*, nfds_t, int))dlsym(RTLD_NEXT, "poll");
    }
    if (nfds == 1 && fds[0].fd >= 0 && fds[0].fd < MAXFD && tracked[fds[0].fd] &&
        (fds[0].events & POLLOUT) && mode() == 1) {
        int ms = timeout < 0 || timeout > 50 ? 50 : timeout;
        usleep(ms * 1000);
        fds[0].revents = POLLOUT;
        return 1;
    }
    return real(fds, nfds, timeout);
}

int close(int fd) {
    static int (*real)(int);
    if (!real) {
        real = (int (*)(int))dlsym(RTLD_NEXT, "close");
    }
    if (fd >= 0 && fd < MAXFD) {
        tracked[fd] = 0;
    }
    return real(fd);
}
