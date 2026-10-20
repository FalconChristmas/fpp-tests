/* co_slowsendmmsg.so: LD_PRELOAD into fppd to make UDP sends slow, the way a
 * send to a congested or paced interface is.  On a thread whose name (prctl
 * PR_GET_NAME) starts with $CO_SLOWSENDMMSG_THREAD -- or, when that starts
 * with '!', on every thread whose name does not start with the rest --
 * sendmmsg() and sendmsg() sleep $CO_SLOWSENDMMSG_MS (default 40) first.
 * (A UDP output sends with sendmmsg(), or with sendmsg() when it is
 * configured as blocking.)
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>

static void maybe_sleep(void) {
    const char* want = getenv("CO_SLOWSENDMMSG_THREAD");
    if (want && *want) {
        int negate = want[0] == '!';
        if (negate) {
            want++;
        }
        char name[17] = { 0 };
        prctl(PR_GET_NAME, name);
        int match = strncmp(name, want, strlen(want)) == 0;
        if (match != negate) {
            const char* ms = getenv("CO_SLOWSENDMMSG_MS");
            usleep((ms ? atoi(ms) : 40) * 1000);
        }
    }
}

int sendmmsg(int fd, struct mmsghdr* msgs, unsigned int vlen, int flags) {
    static int (*real)(int, struct mmsghdr*, unsigned int, int);
    if (!real) {
        real = (int (*)(int, struct mmsghdr*, unsigned int, int))dlsym(RTLD_NEXT, "sendmmsg");
    }
    maybe_sleep();
    return real(fd, msgs, vlen, flags);
}

ssize_t sendmsg(int fd, const struct msghdr* msg, int flags) {
    static ssize_t (*real)(int, const struct msghdr*, int);
    if (!real) {
        real = (ssize_t(*)(int, const struct msghdr*, int))dlsym(RTLD_NEXT, "sendmsg");
    }
    maybe_sleep();
    return real(fd, msg, flags);
}
