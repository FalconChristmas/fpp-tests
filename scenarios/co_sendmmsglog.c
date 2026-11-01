/* co_sendmmsglog.so: LD_PRELOAD into fppd to log how it hands UDP to the
 * kernel.  $SENDMMSGLOG is a file appended to, one line per event:
 *   "sendmmsg <fd> <vlen>"  sendmmsg() of vlen messages on fd
 *   "outq <fd>"             ioctl(fd, SIOCOUTQ), the send-buffer drain check
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>

#ifndef SIOCOUTQ
#define SIOCOUTQ 0x5411
#endif

static void logline(const char* fmt, int fd, unsigned v) {
    const char* path = getenv("SENDMMSGLOG");
    if (!path || !*path) {
        return;
    }
    char buf[64];
    int n = snprintf(buf, sizeof(buf), fmt, fd, v);
    int f = open(path, O_WRONLY | O_APPEND | O_CREAT, 0644);
    if (f >= 0) {
        if (write(f, buf, n) < 0) {
        }
        close(f);
    }
}

int sendmmsg(int fd, struct mmsghdr* msgs, unsigned int vlen, int flags) {
    static int (*real)(int, struct mmsghdr*, unsigned int, int);
    if (!real) {
        real = (int (*)(int, struct mmsghdr*, unsigned int, int))dlsym(RTLD_NEXT, "sendmmsg");
    }
    logline("sendmmsg %d %u\n", fd, vlen);
    return real(fd, msgs, vlen, flags);
}

int ioctl(int fd, unsigned long req, ...) {
    static int (*real)(int, unsigned long, void*);
    if (!real) {
        real = (int (*)(int, unsigned long, void*))dlsym(RTLD_NEXT, "ioctl");
    }
    va_list ap;
    va_start(ap, req);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    if (req == SIOCOUTQ) {
        logline("outq %d %u\n", fd, 0);
    }
    return real(fd, req, arg);
}
