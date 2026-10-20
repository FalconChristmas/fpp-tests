/* co_failsendto.so: LD_PRELOAD into fppd to make every sendto() to UDP port
 * $CO_FAILSENDTO_PORT fail with ENOBUFS, as sends on a busy Wi-Fi interface
 * do.  Nothing is sent.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/types.h>

ssize_t sendto(int fd, const void* buf, size_t len, int flags, const struct sockaddr* to, socklen_t tolen) {
    static ssize_t (*real)(int, const void*, size_t, int, const struct sockaddr*, socklen_t);
    if (!real) {
        real = (ssize_t(*)(int, const void*, size_t, int, const struct sockaddr*, socklen_t))dlsym(RTLD_NEXT, "sendto");
    }
    const char* port = getenv("CO_FAILSENDTO_PORT");
    if (port && to && to->sa_family == AF_INET &&
        ntohs(((const struct sockaddr_in*)to)->sin_port) == atoi(port)) {
        errno = ENOBUFS;
        return -1;
    }
    return real(fd, buf, len, flags, to, tolen);
}
