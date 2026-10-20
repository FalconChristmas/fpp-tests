/* co_net_failsock.so: LD_PRELOAD into fppd to run it out of descriptors on
 * demand.  While the file $CO_FAILSOCK_FLAG exists, socket(AF_INET,
 * SOCK_DGRAM, 0) on a thread whose name (prctl PR_GET_NAME) starts with
 * $CO_FAILSOCK_THREAD (any thread when unset) fails with EMFILE, as it does
 * when fppd has run out of file descriptors.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>

int socket(int domain, int type, int protocol) {
    static int (*real)(int, int, int);
    if (!real) {
        real = (int (*)(int, int, int))dlsym(RTLD_NEXT, "socket");
    }
    const char* flag = getenv("CO_FAILSOCK_FLAG");
    if (flag && domain == AF_INET && (type & 0xff) == SOCK_DGRAM && protocol == 0 &&
        access(flag, F_OK) == 0) {
        const char* want = getenv("CO_FAILSOCK_THREAD");
        char name[17] = { 0 };
        prctl(PR_GET_NAME, name);
        if (!want || strncmp(name, want, strlen(want)) == 0) {
            errno = EMFILE;
            return -1;
        }
    }
    return real(domain, type, protocol);
}
