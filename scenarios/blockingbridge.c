/* blockingbridge.so: LD_PRELOAD into fppd to give its E1.31 and DDP input
 * sockets (UDP 5568 and 4048) the blocking reads they have on macOS, where
 * SOCK_NONBLOCK is defined as 0. On bind() to one of those ports the
 * socket's O_NONBLOCK is cleared, so only a reader that passes MSG_DONTWAIT
 * returns when there is nothing (more) to read.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>

int bind(int fd, const struct sockaddr* addr, socklen_t len) {
    static int (*real)(int, const struct sockaddr*, socklen_t);
    if (!real) {
        real = (int (*)(int, const struct sockaddr*, socklen_t))dlsym(RTLD_NEXT, "bind");
    }
    int rc = real(fd, addr, len);
    int type = 0;
    socklen_t tl = sizeof(type);
    if (rc == 0 && addr && addr->sa_family == AF_INET && len >= sizeof(struct sockaddr_in) &&
        getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &tl) == 0 && type == SOCK_DGRAM) {
        int port = ntohs(((const struct sockaddr_in*)addr)->sin_port);
        if (port == 5568 || port == 4048) {
            int fl = fcntl(fd, F_GETFL);
            if (fl >= 0) {
                fcntl(fd, F_SETFL, fl & ~O_NONBLOCK);
            }
        }
    }
    return rc;
}
