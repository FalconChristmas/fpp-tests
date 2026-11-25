/* slowhttpbind.so: LD_PRELOAD into fppd to hold drogon back before its main
 * loop runs. bind() of the HTTP port (TCP 32322) waits SLOWHTTPBIND_MS
 * (default 3000) first, once: drogon binds the port for each listener on each
 * IO loop, and a wait on every one would hold it back a minute. drogon binds
 * its listeners inside app().run(), before it enters the loop that quit()
 * needs to be running, so for that long a stop or restart lands in the window
 * where quit() does nothing.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

int bind(int fd, const struct sockaddr* addr, socklen_t len) {
    static int (*real)(int, const struct sockaddr*, socklen_t);
    if (!real) {
        real = (int (*)(int, const struct sockaddr*, socklen_t))dlsym(RTLD_NEXT, "bind");
    }
    int port = -1;
    if (addr && addr->sa_family == AF_INET) {
        port = ntohs(((const struct sockaddr_in*)addr)->sin_port);
    } else if (addr && addr->sa_family == AF_INET6) {
        port = ntohs(((const struct sockaddr_in6*)addr)->sin6_port);
    }
    static int waited;
    if (port == 32322 && !__atomic_exchange_n(&waited, 1, __ATOMIC_SEQ_CST)) {
        const char* ms = getenv("SLOWHTTPBIND_MS");
        usleep((ms ? atoi(ms) : 3000) * 1000);
    }
    return real(fd, addr, len);
}
