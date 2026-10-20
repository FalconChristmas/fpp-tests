/* slowrecv.so: LD_PRELOAD into fppd to make its main loop slower at reading
 * input packets than a sender is at sending them, as a single-core board is
 * against a fast show computer or a network loop.  recvmmsg() on fppd's main
 * thread sleeps SLOWRECV_MS (default 10) before reading.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

int recvmmsg(int fd, struct mmsghdr* msgs, unsigned int n, int flags, struct timespec* timeout) {
    static int (*real)(int, struct mmsghdr*, unsigned int, int, struct timespec*);
    if (!real) {
        real = (int (*)(int, struct mmsghdr*, unsigned int, int, struct timespec*))dlsym(RTLD_NEXT, "recvmmsg");
    }
    if (syscall(SYS_gettid) == getpid()) {
        const char* ms = getenv("SLOWRECV_MS");
        usleep((ms ? atoi(ms) : 10) * 1000);
    }
    return real(fd, msgs, n, flags, timeout);
}
