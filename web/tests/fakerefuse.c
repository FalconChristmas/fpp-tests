/* fakerefuse.so: LD_PRELOAD into php-fpm to make a loopback TCP port refuse
 * connections.
 * The web container's fppd is the one the tests judge, so its API port
 * (32322) can't be closed for a test of what the PHP does when fppd is
 * down.  While REFUSE_CONTROL (default /tmp/fpp-tests-refuse) exists, a
 * connect() to 127.0.0.1 on a port listed in it (one number per line) fails
 * with ECONNREFUSED, as it does when nothing listens.  The file is read on
 * each call, so a test turns the refusal on and off without restarting
 * php-fpm.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static const char* control(void) {
    const char* c = getenv("REFUSE_CONTROL");
    return c && *c ? c : "/tmp/fpp-tests-refuse";
}

static int refused(int port) {
    static int (*real_open)(const char*, int, ...);
    if (!real_open)
        real_open = dlsym(RTLD_NEXT, "open");
    int fd = real_open(control(), O_RDONLY);
    if (fd < 0)
        return 0;
    char buf[256];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0)
        return 0;
    buf[n] = '\0';
    for (char* p = strtok(buf, "\n"); p; p = strtok(NULL, "\n"))
        if (atoi(p) == port)
            return 1;
    return 0;
}

int connect(int fd, const struct sockaddr* addr, socklen_t len) {
    static int (*real_connect)(int, const struct sockaddr*, socklen_t);
    if (!real_connect)
        real_connect = dlsym(RTLD_NEXT, "connect");
    if (addr && addr->sa_family == AF_INET) {
        const struct sockaddr_in* in = (const struct sockaddr_in*)addr;
        if (in->sin_addr.s_addr == htonl(INADDR_LOOPBACK) && refused(ntohs(in->sin_port))) {
            errno = ECONNREFUSED;
            return -1;
        }
    }
    return real_connect(fd, addr, len);
}
