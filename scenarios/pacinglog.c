/* pacinglog.so: LD_PRELOAD into fppd to see the kernel pacing rate each UDP
 * output socket is given, and where that socket sends.
 *
 * $PACING_LOG: a file appended to, one line per event:
 *   "rate <fd> <bytes/s>"  setsockopt(SO_MAX_PACING_RATE) on fd
 *   "dest <fd> <a.b.c.d>"  the first sendmmsg()/sendmsg() on fd after a
 *                          rate was set or the fd was first seen, and the
 *                          address its first message goes to
 *   "sndtimeo <fd> <usec>" setsockopt(SO_SNDTIMEO) on fd
 *   "close <fd>"           close() of an fd seen above
 * fds are reused, so a reader pairs each "dest" with the "rate" lines on that
 * fd since its last "close".
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <stdarg.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef SO_MAX_PACING_RATE
#define SO_MAX_PACING_RATE 47
#endif

#define MAXFD 4096
static unsigned char seen[MAXFD];
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void logline(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void logline(const char* fmt, ...) {
    const char* path = getenv("PACING_LOG");
    if (!path || !*path) {
        return;
    }
    char buf[128];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    pthread_mutex_lock(&lock);
    FILE* f = fopen(path, "a");
    if (f) {
        fputs(buf, f);
        fclose(f);
    }
    pthread_mutex_unlock(&lock);
}

static void note_dest(int fd, const struct msghdr* h) {
    if (fd < 0 || fd >= MAXFD || seen[fd] == 2 || !h || !h->msg_name ||
        h->msg_namelen < sizeof(struct sockaddr_in)) {
        return;
    }
    const struct sockaddr_in* sa = (const struct sockaddr_in*)h->msg_name;
    if (sa->sin_family != AF_INET) {
        return;
    }
    char ip[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &sa->sin_addr, ip, sizeof(ip));
    seen[fd] = 2;
    logline("dest %d %s\n", fd, ip);
}

int setsockopt(int fd, int level, int name, const void* val, socklen_t len) {
    static int (*real)(int, int, int, const void*, socklen_t);
    if (!real) {
        real = dlsym(RTLD_NEXT, "setsockopt");
    }
    int r = real(fd, level, name, val, len);
    if (level == SOL_SOCKET && name == SO_MAX_PACING_RATE && val && len >= sizeof(unsigned int)) {
        logline("rate %d %u\n", fd, *(const unsigned int*)val);
        if (fd >= 0 && fd < MAXFD) {
            seen[fd] = 1;
        }
    }
    if (level == SOL_SOCKET && name == SO_SNDTIMEO && val && len >= sizeof(struct timeval)) {
        const struct timeval* tv = (const struct timeval*)val;
        logline("sndtimeo %d %ld\n", fd, (long)(tv->tv_sec * 1000000L + tv->tv_usec));
    }
    return r;
}

int sendmmsg(int fd, struct mmsghdr* v, unsigned int n, int flags) {
    static int (*real)(int, struct mmsghdr*, unsigned int, int);
    if (!real) {
        real = dlsym(RTLD_NEXT, "sendmmsg");
    }
    if (n > 0) {
        note_dest(fd, &v[0].msg_hdr);
    }
    return real(fd, v, n, flags);
}

ssize_t sendmsg(int fd, const struct msghdr* h, int flags) {
    static ssize_t (*real)(int, const struct msghdr*, int);
    if (!real) {
        real = dlsym(RTLD_NEXT, "sendmsg");
    }
    note_dest(fd, h);
    return real(fd, h, flags);
}

int close(int fd) {
    static int (*real)(int);
    if (!real) {
        real = dlsym(RTLD_NEXT, "close");
    }
    if (fd >= 0 && fd < MAXFD && seen[fd]) {
        seen[fd] = 0;
        logline("close %d\n", fd);
    }
    return real(fd);
}
