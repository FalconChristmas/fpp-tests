/* netlinkfail.so: LD_PRELOAD into fppd to fail NetworkMonitor's netlink
 * socket.  With $NLFAIL=socket, socket(AF_NETLINK, ..., NETLINK_ROUTE)
 * fails with EMFILE when NetworkMonitor is on the stack (getifaddrs() and
 * the rest open the same kind of socket and are left alone).  With
 * $NLFAIL=bind, bind() of an AF_NETLINK socket asking for multicast groups
 * -- only NetworkMonitor's does -- fails with EADDRINUSE.  Each failure
 * made is appended to $NLFAIL_LOG.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <execinfo.h>
#include <fcntl.h>
#include <linux/netlink.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int mode_is(const char* want) {
    const char* mode = getenv("NLFAIL");
    return mode && strcmp(mode, want) == 0;
}

static void note(const char* what) {
    const char* log = getenv("NLFAIL_LOG");
    int fd = log ? open(log, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644) : -1;
    if (fd >= 0) {
        (void)!write(fd, what, strlen(what));
        (void)!write(fd, "\n", 1);
        close(fd);
    }
}

static int from_network_monitor(void) {
    void* frames[12];
    int n = backtrace(frames, 12);
    for (int i = 0; i < n; i++) {
        Dl_info info = { 0 };
        if (dladdr(frames[i], &info) && info.dli_sname && strstr(info.dli_sname, "NetworkMonitor")) {
            return 1;
        }
    }
    return 0;
}

int socket(int domain, int type, int protocol) {
    static int (*real)(int, int, int);
    if (!real) {
        real = (int (*)(int, int, int))dlsym(RTLD_NEXT, "socket");
    }
    if (domain == AF_NETLINK && protocol == NETLINK_ROUTE && mode_is("socket") && from_network_monitor()) {
        note("socket");
        errno = EMFILE;
        return -1;
    }
    return real(domain, type, protocol);
}

int bind(int fd, const struct sockaddr* addr, socklen_t len) {
    static int (*real)(int, const struct sockaddr*, socklen_t);
    if (!real) {
        real = (int (*)(int, const struct sockaddr*, socklen_t))dlsym(RTLD_NEXT, "bind");
    }
    if (addr && addr->sa_family == AF_NETLINK && len >= sizeof(struct sockaddr_nl) &&
        ((const struct sockaddr_nl*)addr)->nl_groups != 0 && mode_is("bind")) {
        note("bind");
        errno = EADDRINUSE;
        return -1;
    }
    return real(fd, addr, len);
}
