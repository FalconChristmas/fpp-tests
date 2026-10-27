/* Fails one UDP send in RTPDROP_EVERY (default 16) to port RTPDROP_PORT
 * (default 5004) with EPERM, as a congested or filtered link would: the
 * sender's udpsink skips that packet and doesn't count it in bytes-served,
 * so the stream delivers 1 - 1/N of its audio. Other sends are untouched. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <sys/socket.h>

static int (*real_sendmmsg)(int, struct mmsghdr*, unsigned int, int);
static ssize_t (*real_sendmsg)(int, const struct msghdr*, int);
static int port = 5004, every = 16;
static atomic_uint count;

__attribute__((constructor)) static void init(void) {
    real_sendmmsg = dlsym(RTLD_NEXT, "sendmmsg");
    real_sendmsg = dlsym(RTLD_NEXT, "sendmsg");
    if (getenv("RTPDROP_PORT")) port = atoi(getenv("RTPDROP_PORT"));
    if (getenv("RTPDROP_EVERY")) every = atoi(getenv("RTPDROP_EVERY"));
}

static int to_port(const struct msghdr* m) {
    const struct sockaddr_in* a = m->msg_name;
    return a && m->msg_namelen >= sizeof(*a) && a->sin_family == AF_INET && ntohs(a->sin_port) == port;
}

/* Whether this packet is the one in `every` to fail. */
static int drop(const struct msghdr* m) {
    return to_port(m) && atomic_fetch_add(&count, 1) % every == every - 1;
}

int sendmmsg(int fd, struct mmsghdr* v, unsigned int n, int flags) {
    for (unsigned int i = 0; i < n; i++) {
        if (drop(&v[i].msg_hdr)) {
            if (i == 0) {
                errno = EPERM;
                return -1;
            }
            return real_sendmmsg(fd, v, i, flags);
        }
    }
    return real_sendmmsg(fd, v, n, flags);
}

ssize_t sendmsg(int fd, const struct msghdr* m, int flags) {
    if (drop(m)) {
        errno = EPERM;
        return -1;
    }
    return real_sendmsg(fd, m, flags);
}
