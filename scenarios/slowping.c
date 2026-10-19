/* slowping.so: LD_PRELOAD into fppd to hold its ping thread up just after
 * ICMP replies arrive, the way a blocking name lookup or a busy single-core
 * board does.  poll() on the thread named FPP-PingThread sleeps SLOWPING_MS
 * (default 400, longer than a controller ping's 250 ms timeout) whenever it
 * reports something to read, so the replies to a burst of pings are all
 * queued, and all older than their timeout, by the time the thread reads.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

int poll(struct pollfd* fds, nfds_t nfds, int timeout) {
    static int (*real)(struct pollfd*, nfds_t, int);
    if (!real) {
        real = (int (*)(struct pollfd*, nfds_t, int))dlsym(RTLD_NEXT, "poll");
    }
    int r = real(fds, nfds, timeout);
    if (r > 0) {
        char name[17] = { 0 };
        prctl(PR_GET_NAME, name);
        if (strcmp(name, "FPP-PingThread") == 0) {
            const char* ms = getenv("SLOWPING_MS");
            usleep((ms ? atoi(ms) : 400) * 1000);
        }
    }
    return r;
}
