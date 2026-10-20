/* blocksend.so: LD_PRELOAD into fppd to make its MultiSync multicast and
 * broadcast sockets behave as they do when the interface has stopped
 * transmitting (Wi-Fi gone quiet) and their send buffers are full.
 * sendto() to port 32320 at a multicast address, or at an address ending
 * in .255, fails with EAGAIN when called with MSG_DONTWAIT, and otherwise
 * blocks BLOCKSEND_MS (default 3000) before sending.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

ssize_t sendto(int fd, const void* buf, size_t len, int flags,
               const struct sockaddr* addr, socklen_t alen) {
    static ssize_t (*real)(int, const void*, size_t, int, const struct sockaddr*, socklen_t);
    if (!real) {
        real = (ssize_t (*)(int, const void*, size_t, int, const struct sockaddr*, socklen_t))
            dlsym(RTLD_NEXT, "sendto");
    }
    if (addr && alen >= sizeof(struct sockaddr_in) && addr->sa_family == AF_INET) {
        const struct sockaddr_in* to = (const struct sockaddr_in*)addr;
        uint32_t a = ntohl(to->sin_addr.s_addr);
        if (ntohs(to->sin_port) == 32320 && (IN_MULTICAST(a) || (a & 0xFF) == 0xFF)) {
            if (flags & MSG_DONTWAIT) {
                errno = EAGAIN;
                return -1;
            }
            const char* ms = getenv("BLOCKSEND_MS");
            usleep((ms ? atoi(ms) : 3000) * 1000);
        }
    }
    return real(fd, buf, len, flags, addr, alen);
}
