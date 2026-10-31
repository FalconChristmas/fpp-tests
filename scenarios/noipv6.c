/* noipv6.so: LD_PRELOAD into fppd to take IPv6 away, the two ways a real
 * box can lack it.
 *
 *   NOIPV6_MODE=socket  socket(AF_INET6, ...) fails with EAFNOSUPPORT, as on
 *                       a kernel built without IPv6 or booted ipv6.disable=1.
 *   NOIPV6_MODE=bind    sockets open, but bind() to [::1] fails with
 *                       EADDRNOTAVAIL, as with disable_ipv6=1 on lo.
 *
 * Every refusal appends a line to $NOIPV6_LOG, so a scenario can tell that
 * the shim was loaded and fppd actually tried.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int mode_is(const char* m) {
    const char* v = getenv("NOIPV6_MODE");
    return v && strcmp(v, m) == 0;
}

static void note(const char* what) {
    const char* log = getenv("NOIPV6_LOG");
    int fd = log ? open(log, O_WRONLY | O_APPEND | O_CREAT, 0644) : -1;
    if (fd >= 0) {
        write(fd, what, strlen(what));
        write(fd, "\n", 1);
        close(fd);
    }
}

int socket(int domain, int type, int protocol) {
    static int (*real)(int, int, int);
    if (!real) {
        real = (int (*)(int, int, int))dlsym(RTLD_NEXT, "socket");
    }
    if (domain == AF_INET6 && mode_is("socket")) {
        note("socket");
        errno = EAFNOSUPPORT;
        return -1;
    }
    return real(domain, type, protocol);
}

int bind(int fd, const struct sockaddr* addr, socklen_t len) {
    static int (*real)(int, const struct sockaddr*, socklen_t);
    if (!real) {
        real = (int (*)(int, const struct sockaddr*, socklen_t))dlsym(RTLD_NEXT, "bind");
    }
    if (addr && addr->sa_family == AF_INET6 && len >= sizeof(struct sockaddr_in6) && mode_is("bind")) {
        const struct sockaddr_in6* a6 = (const struct sockaddr_in6*)addr;
        if (memcmp(&a6->sin6_addr, &in6addr_loopback, sizeof(in6addr_loopback)) == 0) {
            note("bind");
            errno = EADDRNOTAVAIL;
            return -1;
        }
    }
    return real(fd, addr, len);
}
