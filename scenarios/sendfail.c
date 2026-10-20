/* sendfail.so: LD_PRELOAD into fppd to make every channel data send to one
 * controller fail while the controller itself stays up and answers its
 * pings, as one whose receive buffer is full or behind a dropping switch
 * port looks to the output.  sendmmsg() and sendmsg() whose (first)
 * destination is SENDFAIL_ADDR (default 127.0.0.2) fail with EPERM; every
 * other send, and ICMP, goes through.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <sys/socket.h>

static int blocked(const struct msghdr* m) {
    if (!m || !m->msg_name || m->msg_namelen < sizeof(struct sockaddr_in)) {
        return 0;
    }
    const struct sockaddr_in* to = (const struct sockaddr_in*)m->msg_name;
    if (to->sin_family != AF_INET) {
        return 0;
    }
    const char* a = getenv("SENDFAIL_ADDR");
    return to->sin_addr.s_addr == inet_addr(a ? a : "127.0.0.2");
}

int sendmmsg(int fd, struct mmsghdr* msgs, unsigned int n, int flags) {
    static int (*real)(int, struct mmsghdr*, unsigned int, int);
    if (!real) {
        real = (int (*)(int, struct mmsghdr*, unsigned int, int))dlsym(RTLD_NEXT, "sendmmsg");
    }
    if (n && blocked(&msgs[0].msg_hdr)) {
        errno = EPERM;
        return -1;
    }
    return real(fd, msgs, n, flags);
}

ssize_t sendmsg(int fd, const struct msghdr* msg, int flags) {
    static ssize_t (*real)(int, const struct msghdr*, int);
    if (!real) {
        real = (ssize_t (*)(int, const struct msghdr*, int))dlsym(RTLD_NEXT, "sendmsg");
    }
    if (blocked(msg)) {
        errno = EPERM;
        return -1;
    }
    return real(fd, msg, flags);
}
