/* slowhttpclose.so: LD_PRELOAD into fppd to make drogon's teardown slow.
 * close() of a listening socket on the HTTP port (TCP 32322) waits
 * SLOWHTTPCLOSE_MS (default 200) first. drogon closes its listeners in the
 * teardown that quit() queues on its main loop, so for that long the
 * teardown is still running -- as it can be on a loaded box -- and anything
 * that asks it to quit again meanwhile asks a second time.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

int close(int fd) {
    static int (*real)(int);
    if (!real) {
        real = (int (*)(int))dlsym(RTLD_NEXT, "close");
    }
    int listening = 0;
    socklen_t len = sizeof(listening);
    struct sockaddr_storage ss;
    socklen_t sslen = sizeof(ss);
    if (getsockopt(fd, SOL_SOCKET, SO_ACCEPTCONN, &listening, &len) == 0 && listening &&
        getsockname(fd, (struct sockaddr*)&ss, &sslen) == 0) {
        int port = -1;
        if (ss.ss_family == AF_INET) {
            port = ntohs(((struct sockaddr_in*)&ss)->sin_port);
        } else if (ss.ss_family == AF_INET6) {
            port = ntohs(((struct sockaddr_in6*)&ss)->sin6_port);
        }
        if (port == 32322) {
            const char* ms = getenv("SLOWHTTPCLOSE_MS");
            usleep((ms ? atoi(ms) : 200) * 1000);
        }
    }
    return real(fd);
}
