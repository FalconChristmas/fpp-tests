/* slowrawsend.so: LD_PRELOAD into fppd to stall a ping's send on the thread
 * that asked for it.  sendto() on a raw socket from any thread but the ping
 * thread (FPP-PingThread) sleeps SLOWRAWSEND_MS (default 600) before it
 * sends, the way a single-core board stalls a caller between publishing a
 * ping target and sending it.  The ping thread's own sends are left alone.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>

ssize_t sendto(int fd, const void* buf, size_t len, int flags, const struct sockaddr* to, socklen_t tolen) {
    static ssize_t (*real)(int, const void*, size_t, int, const struct sockaddr*, socklen_t);
    if (!real) {
        real = (ssize_t (*)(int, const void*, size_t, int, const struct sockaddr*, socklen_t))dlsym(RTLD_NEXT, "sendto");
    }
    int type = 0;
    socklen_t l = sizeof(type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &l) == 0 && type == SOCK_RAW) {
        char name[17] = { 0 };
        prctl(PR_GET_NAME, name);
        if (strcmp(name, "FPP-PingThread") != 0) {
            const char* ms = getenv("SLOWRAWSEND_MS");
            usleep((ms ? atoi(ms) : 600) * 1000);
        }
    }
    return real(fd, buf, len, flags, to, tolen);
}
