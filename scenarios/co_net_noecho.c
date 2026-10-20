/* co_net_noecho.so: LD_PRELOAD into fppd to make one address stop answering
 * its pings while everything else about it still works.  recvfrom() on the
 * thread named FPP-PingThread drops (reads and discards, then reports
 * EAGAIN) every packet from $CO_NOECHO_ADDR, so fppd's pings to it all time
 * out, as they do to a powered-off controller.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>

ssize_t recvfrom(int fd, void* buf, size_t len, int flags, struct sockaddr* from, socklen_t* fromlen) {
    static ssize_t (*real)(int, void*, size_t, int, struct sockaddr*, socklen_t*);
    if (!real) {
        real = (ssize_t(*)(int, void*, size_t, int, struct sockaddr*, socklen_t*))dlsym(RTLD_NEXT, "recvfrom");
    }
    ssize_t r = real(fd, buf, len, flags, from, fromlen);
    const char* addr = getenv("CO_NOECHO_ADDR");
    if (r >= 0 && addr && from && from->sa_family == AF_INET) {
        char name[17] = { 0 };
        prctl(PR_GET_NAME, name);
        struct in_addr want;
        if (strcmp(name, "FPP-PingThread") == 0 && inet_aton(addr, &want) &&
            ((struct sockaddr_in*)from)->sin_addr.s_addr == want.s_addr) {
            errno = EAGAIN;
            return -1;
        }
    }
    return r;
}
