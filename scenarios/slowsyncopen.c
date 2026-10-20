/* slowsyncopen.so: LD_PRELOAD into fppd to make sending a MultiSync "open"
 * packet slow, as a congested Wi-Fi link makes it.  A sendmmsg() or sendto()
 * whose first message is a MultiSync sync packet with the open action waits
 * $SLOWSYNCOPEN_MS (default 300) first.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void maybe_wait(const void* buf, size_t len) {
    const unsigned char* p = (const unsigned char*)buf;
    /* "FPPD", packet type 1 (sync), 2 length bytes, action 3 (open) */
    if (!p || len < 9 || memcmp(p, "FPPD", 4) != 0 || p[4] != 0x01 || p[7] != 3)
        return;
    const char* ms = getenv("SLOWSYNCOPEN_MS");
    usleep((ms ? atoi(ms) : 300) * 1000);
}

int sendmmsg(int fd, struct mmsghdr* msgs, unsigned int n, int flags) {
    static int (*real)(int, struct mmsghdr*, unsigned int, int);
    if (!real)
        real = (int (*)(int, struct mmsghdr*, unsigned int, int))dlsym(RTLD_NEXT, "sendmmsg");
    if (n > 0 && msgs[0].msg_hdr.msg_iovlen > 0)
        maybe_wait(msgs[0].msg_hdr.msg_iov[0].iov_base, msgs[0].msg_hdr.msg_iov[0].iov_len);
    return real(fd, msgs, n, flags);
}

ssize_t sendto(int fd, const void* buf, size_t len, int flags, const struct sockaddr* to, socklen_t tolen) {
    static ssize_t (*real)(int, const void*, size_t, int, const struct sockaddr*, socklen_t);
    if (!real)
        real = (ssize_t(*)(int, const void*, size_t, int, const struct sockaddr*, socklen_t))dlsym(RTLD_NEXT, "sendto");
    maybe_wait(buf, len);
    return real(fd, buf, len, flags, to, tolen);
}
